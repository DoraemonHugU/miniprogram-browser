/**
 * runtime-snapshot.ts — WXML 解析与快照树构建
 *
 * 本模块包含 miniprogram-browser 的页面结构快照功能：
 * - WXML 标签/属性解析
 * - 快照节点类型判定与转换（精简 vs 原始模式）
 * - 树结构构建、排序、剪枝、去重、深度限制
 * - 节点稳定键（stableKey）和规范路径（canonicalPath）分配
 *
 * 依赖 runtime-core 的纯格式化函数。
 */

const {
  normalizeRuntimeRoute,
  resolveRuntimeStableText,
} = require('./runtime-core')

// ---- 快照本地类型 ----

/** WXML 解析出的属性字典（值为字符串） */
type WxmlAttributes = Record<string, string>

/** 快照后处理选项（compact / depth / raw） */
type SnapshotOptions = {
  compact?: boolean
  depth?: number
  raw?: boolean
  queryTimeoutMs?: number
  elementTimeoutMs?: number
}

/** 节点匹配策略（与 ref record 的 strategy 对齐，字段均为可选） */
interface SnapshotStrategy {
  kind: string
  value?: string | null
  selector?: string | null
  index?: number
}

/**
 * 快照节点：精简模式与原始模式共用同一形状。
 * 所有字段均为可选，以便上层用结构化对象或纯测试对象构造。
 */
interface SnapshotNode {
  runtimeKey?: string
  businessKey?: string | null
  selector?: string | null
  kind?: string
  tagName?: string
  identityText?: string
  text?: string
  rawText?: string
  strategy?: SnapshotStrategy
  children?: SnapshotNode[]
  canonicalPath?: string
  parentKey?: string | null
  order?: number
  index?: number
  outerWxml?: string
  attributes?: WxmlAttributes
  registryId?: string | null
  testid?: string | null
  scopeKey?: string | null
  route?: string
  stableKey?: string | null
}

/** 快照采集的元素句柄（自动化 API 的子集） */
interface SnapshotElement {
  tagName?: string
  text(): Promise<string>
  outerWxml(): Promise<string>
}

/** 快照采集的页面句柄（自动化 API 的子集） */
interface SnapshotPage {
  path?: string
  query?: Record<string, unknown>
  $$(selector: string): Promise<SnapshotElement[]>
}

/** ref record 的精简视图，仅取 subtreeForScope / matchesRecord 所需的字段 */
interface RefRecordLike {
  route?: string
  stableKey?: string | null
  businessKey?: string | null
  strategy?: SnapshotStrategy
}

// ---- 快照种子标签 ----

/** 读取运行时快照树时优先检索的种子标签列表 */
const RUNTIME_SNAPSHOT_SEED_TAGS = [
  'view',
  'text',
  'button',
  'input',
  'textarea',
  'image',
  'navigator',
  'label',
  'scroll-view',
  'swiper',
  'swiper-item',
  'switch',
  'checkbox',
  'radio',
  'slider',
  'icon',
  'progress',
]

const DEFAULT_RUNTIME_SNAPSHOT_QUERY_TIMEOUT_MS = 3000
const DEFAULT_RUNTIME_SNAPSHOT_ELEMENT_TIMEOUT_MS = 3000

/** 可交互标签集合：可点击/输入的 WXML 组件 */
const INTERACTIVE_RUNTIME_TAGS = new Set([
  'button',
  'input',
  'textarea',
  'navigator',
  'switch',
  'checkbox',
  'radio',
  'slider',
])

/** 纯内容标签集合：主要承载文本的 WXML 组件 */
const CONTENT_RUNTIME_TAGS = new Set([
  'text',
  'label',
])

/** 结构容器标签集合：提供滚动/滑动能力的 WXML 组件 */
const STRUCTURAL_RUNTIME_TAGS = new Set([
  'scroll-view',
  'swiper',
])

// ---- WXML 解析 ----

/**
 * 从 outerWxml 中收集所有标签名。
 * 以种子标签为基线，扩展扫描到页面实际用到的额外标签。
 */
function collectTagNamesFromWxml(wxml: string): string[] {
  const tags = new Set(RUNTIME_SNAPSHOT_SEED_TAGS)
  const regex = /<([a-zA-Z][\w-]*)\b/gu
  let match: RegExpExecArray | null

  while ((match = regex.exec(wxml || '')) !== null) {
    tags.add(match[1])
  }

  return [...tags]
}

/**
 * 解析单个 WXML 标签的开始标记，提取标签名和属性字典。
 * 支持双引号、单引号、无引号属性值。
 */
function parseOpeningTagAttributes(outerWxml: string): { tagName: string; attributes: WxmlAttributes } {
  const match = String(outerWxml || '').match(/^<([a-zA-Z][\w-]*)([^>]*)>/u)
  if (!match) {
    return { tagName: '', attributes: {} }
  }

  const attributes: WxmlAttributes = {}
  const attrRegex = /([:@a-zA-Z_][\w:.-]*)(?:=("([^"]*)"|'([^']*)'|([^\s>]+)))?/gu
  let attrMatch: RegExpExecArray | null

  while ((attrMatch = attrRegex.exec(match[2])) !== null) {
    const [, name, , doubleQuoted, singleQuoted, bareValue] = attrMatch
    attributes[name] = doubleQuoted ?? singleQuoted ?? bareValue ?? ''
  }

  return {
    tagName: match[1],
    attributes,
  }
}

// ---- 节点属性派生 ----

/** 规范化运行时文本：合并空白、去前后空格 */
function normalizeRuntimeText(value: string): string {
  return String(value || '').replace(/\s+/gu, ' ').trim()
}

/**
 * 从 WXML 属性中推导业务键。
 * 优先显式 id；忽略 Taro 等编译器为普通节点生成的相同短 id/data-sid。
 */
function deriveRuntimeBusinessKey(attributes: WxmlAttributes): string | null {
  const id = normalizeRuntimeText(attributes.id)
  const dataSid = normalizeRuntimeText(attributes['data-sid'])
  const generatedKey = id && id === dataSid && /^_[a-zA-Z0-9]+$/u.test(id)

  if (id && !generatedKey) {
    return `id:${id}`
  }

  if (dataSid && !generatedKey) {
    return `data-sid:${dataSid}`
  }

  return null
}

/** 从标签名和属性推导用于 $$() 的选择器表达式 */
function deriveRuntimeSelector(tagName: string, attributes: WxmlAttributes): string {
  const id = normalizeRuntimeText(attributes.id)
  const dataSid = normalizeRuntimeText(attributes['data-sid'])
  const generatedKey = id && id === dataSid && /^_[a-zA-Z0-9]+$/u.test(id)

  if (id && !generatedKey) {
    return `[id="${id.replace(/(["\\])/gu, '\\$1')}"]`
  }

  if (dataSid && !generatedKey) {
    return `[data-sid="${dataSid}"]`
  }

  return tagName
}

/**
 * 推导节点语义类别（kind）。
 * 优先级：role 属性 > 交互性判断 > 标签名。
 */
function deriveRuntimeKind(tagName: string, attributes: WxmlAttributes): string {
  const role = normalizeRuntimeText(attributes.role)
  if (role) {
    return role
  }

  if (
    tagName === 'view'
    && (
      attributes['hover-class']
      || attributes.bindtap
      || attributes.catchtap
      || attributes.bindlongpress
      || attributes.catchlongpress
      || attributes.bindlongtap
      || attributes.catchlongtap
    )
  ) {
    return 'button'
  }

  return tagName || 'custom'
}

/**
 * 推导需要保留的节点文本。
 * 仅对交互式/内容类标签保留文本，普通容器节点的文本不保留（避免冗余）。
 */
function deriveRuntimeText(tagName: string, attributes: WxmlAttributes, text: string, outerWxml = ''): string {
  const normalized = normalizeRuntimeText(text)
  if (!normalized) {
    return ''
  }

  if (tagName === 'navigator') {
    const firstText = String(outerWxml || '').match(/<text\b[^>]*>([^<]+)<\/text>/u)
    if (firstText) {
      return normalizeRuntimeText(firstText[1])
    }
  }

  if (INTERACTIVE_RUNTIME_TAGS.has(tagName)) {
    return normalized
  }

  if (tagName === 'text' || tagName === 'label') {
    return normalized
  }

  // DevTools 编译后的 outerWxml 可能移除事件绑定。显式 id/data-sid 且只含
  // 直接文本的 view 仍是稳定、低噪音的操作候选，应保留给 Agent。
  if (deriveRuntimeBusinessKey(attributes)) {
    const directText = String(outerWxml || '').match(/^<([a-zA-Z][\w-]*)\b[^>]*>\s*([^<]+?)\s*<\/\1>$/u)
    if (directText) {
      return normalizeRuntimeText(directText[2])
    }
  }

  if (
    attributes['hover-class']
    || attributes.bindtap
    || attributes.catchtap
    || attributes.bindlongpress
    || attributes.catchlongpress
    || attributes.bindlongtap
    || attributes.catchlongtap
    || attributes.role
  ) {
    return normalized
  }

  return ''
}

// ---- 节点类型判定 ----

/** 快照节点是否为可交互元素 */
function isInteractiveRuntimeNode(node: SnapshotNode): boolean {
  return INTERACTIVE_RUNTIME_TAGS.has(node.kind || '') || node.kind === 'button'
}

/** 快照节点是否为纯内容元素 */
function isContentRuntimeNode(node: SnapshotNode): boolean {
  const hasText = Boolean(normalizeRuntimeText(node.text || ''))
  return hasText && (
    CONTENT_RUNTIME_TAGS.has(node.tagName || '')
    || Boolean(node.businessKey)
  )
}

/** 快照节点是否为结构容器元素 */
function isStructuralRuntimeNode(node: SnapshotNode): boolean {
  return STRUCTURAL_RUNTIME_TAGS.has(node.tagName || node.kind || '')
}

// ---- 节点转换 ----

/** 将原始节点转换为语义化的精简快照节点 */
function toSemanticRuntimeKind(node: SnapshotNode, childCount: number): string {
  if (isInteractiveRuntimeNode(node)) {
    return node.kind || 'custom'
  }

  if (isContentRuntimeNode(node)) {
    return node.kind || 'custom'
  }

  if (isStructuralRuntimeNode(node)) {
    return node.tagName || 'view'
  }

  if (childCount > 0) {
    return node.tagName || 'view'
  }

  return node.kind || 'custom'
}

/** 将原始节点转换为精简快照节点（给模型使用的语义化表示） */
function toSnapshotNode(node: SnapshotNode, children: SnapshotNode[] = []): SnapshotNode {
  return {
    businessKey: node.businessKey || undefined,
    selector: node.selector,
    index: Number(node.index || 0),
    kind: toSemanticRuntimeKind(node, children.length),
    identityText: normalizeRuntimeText(node.text || ''),
    text: isInteractiveRuntimeNode(node) || isContentRuntimeNode(node)
      ? normalizeRuntimeText(node.text || '')
      : '',
    children,
  }
}

/** 将原始节点转换为包含完整元数据的原始快照节点 */
function toRawRuntimeNode(node: SnapshotNode, children: SnapshotNode[] = []): SnapshotNode {
  const rawText = normalizeRuntimeText(node.rawText || node.text || '')
  return {
    businessKey: node.businessKey || undefined,
    selector: node.selector,
    index: Number(node.index || 0),
    kind: node.kind || node.tagName || 'view',
    tagName: node.tagName || 'view',
    identityText: rawText,
    text: rawText,
    strategy: {
      kind: 'selector',
      selector: node.selector,
      index: Number(node.index || 0),
    },
    children,
  }
}

// ---- 树结构变换 ----

/** 保留节点自身语义，不把相邻 section 文本自动拼入可操作标签。 */
function enrichRuntimeNodeContext(nodes: SnapshotNode[]): SnapshotNode[] {
  return (nodes || []).map((node) => ({
    ...node,
    children: enrichRuntimeNodeContext(node.children || []),
  }))
}

/** 移除被可交互兄弟节点文本覆盖的冗余文本节点 */
function collapseRedundantTextNodes(nodes: SnapshotNode[]): SnapshotNode[] {
  const nextNodes = (nodes || []).map((node) => ({
    ...node,
    children: collapseRedundantTextNodes(node.children || []),
  }))

  return nextNodes.filter((node) => {
    if (node.kind !== 'text') {
      return true
    }

    const text = normalizeRuntimeText(node.text || '')
    if (!text) {
      return false
    }

    const coveredByClickableSibling = nextNodes.some((sibling) => sibling !== node
      && sibling.kind === 'button'
      && normalizeRuntimeText(sibling.text || '').includes(text))

    return !coveredByClickableSibling
  })
}

/** 展开节点组数组（支持嵌套数组和空值过滤） */
function flattenNodeGroups(groups: (SnapshotNode | SnapshotNode[])[]): SnapshotNode[] {
  const result: SnapshotNode[] = []
  for (const group of groups) {
    if (Array.isArray(group)) {
      result.push(...group)
      continue
    }
    if (group) {
      result.push(group)
    }
  }
  return result
}

/** 递归剪枝：仅保留交互/内容节点及其容器路径 */
function pruneRuntimeNode(node: SnapshotNode, depth = 0): SnapshotNode[] {
  if (isInteractiveRuntimeNode(node)) {
    return [toSnapshotNode(node)]
  }

  if (isContentRuntimeNode(node)) {
    return [toSnapshotNode(node)]
  }

  const children = flattenNodeGroups((node.children || []).map((child) => pruneRuntimeNode(child, depth + 1)))
  if (isStructuralRuntimeNode(node)) {
    return [toSnapshotNode(node, children)]
  }

  if (!children.length) {
    return []
  }

  const shouldKeepContainer = children.length > 1
  if (!shouldKeepContainer || depth === 0) {
    return children
  }

  return [toSnapshotNode(node, children)]
}

/** 限制快照树最大深度（防止过深的 VDOM 展开） */
function limitSnapshotDepth(nodes: SnapshotNode[], maxDepth: number, currentDepth = 1): SnapshotNode[] {
  if (!Number.isFinite(maxDepth) || maxDepth <= 0) {
    return nodes
  }

  return (nodes || []).map((node) => {
    if (currentDepth >= maxDepth) {
      return {
        ...node,
        children: [],
      }
    }

    return {
      ...node,
      children: limitSnapshotDepth(node.children || [], maxDepth, currentDepth + 1),
    }
  })
}

/** 压缩快照树：移除无文本、无交互的纯容器节点（直接展开其子节点） */
function compactSnapshotNodes(nodes: SnapshotNode[]): SnapshotNode[] {
  const compacted: SnapshotNode[] = []

  for (const node of nodes || []) {
    const nextChildren = compactSnapshotNodes(node.children || [])
    const nextNode = {
      ...node,
      children: nextChildren,
    }

    const isEmptyContainer = !String(nextNode.text || '').trim()
      && nextChildren.length > 0
      && !isInteractiveRuntimeNode(nextNode)
      && !isContentRuntimeNode(nextNode)
      && !isStructuralRuntimeNode(nextNode)

    if (isEmptyContainer) {
      compacted.push(...nextChildren)
      continue
    }

    compacted.push(nextNode)
  }

  return compacted
}

// ---- 节点标识系统 ----

/**
 * 为节点构建规范标识（canonical identity）。
 * 优先级：registryId > testid > businessKey > (kind+selector+text)。
 */
function buildCanonicalIdentity(node: SnapshotNode): string | null {
  if (!node || typeof node !== 'object') {
    return null
  }

  if (node.registryId) {
    return `registry:${String(node.registryId)}`
  }
  if (node.testid) {
    return `testid:${String(node.testid)}`
  }
  if (node.businessKey) {
    return `business:${String(node.businessKey)}`
  }
  if (node.scopeKey) {
    return `scope:${String(node.scopeKey)}`
  }
  const normalizedText = resolveRuntimeStableText(node)
  if (normalizedText && node.selector) {
    return `${node.kind || 'custom'}:${String(node.selector)}|text:${normalizedText}`
  }
  if (node.selector) {
    return `${node.kind || 'custom'}:${String(node.selector)}`
  }

  return null
}

/** 为节点树分配规范路径（/identity#occurrence 格式），便于稳定引用 */
function assignCanonicalPaths(nodes: SnapshotNode[], parentPath = ''): SnapshotNode[] {
  const siblingOccurrences = new Map()

  return (nodes || []).map((node) => {
    const identity = buildCanonicalIdentity(node)
    let canonicalPath = parentPath

    if (identity) {
      const seenCount = siblingOccurrences.get(identity) || 0
      siblingOccurrences.set(identity, seenCount + 1)
      const occurrenceSuffix = seenCount > 0 ? `#${seenCount + 1}` : ''
      const segment = `${identity}${occurrenceSuffix}`
      canonicalPath = parentPath ? `${parentPath}/${segment}` : segment
    }

    return {
      ...node,
      canonicalPath,
      children: assignCanonicalPaths(node.children || [], canonicalPath),
    }
  })
}

/** 为节点构建跨页面引用的稳定键（pageKey|canonicalPath） */
function buildNodeStableKey(pageKey: string, route: string, node: SnapshotNode): string {
  if (!node || typeof node !== 'object') {
    return ''
  }

  const stablePath = node.canonicalPath ? String(node.canonicalPath) : ''
  return stablePath ? `${pageKey || route}|${stablePath}` : ''
}

/** 构建节点记录的签名（用于后续 staleness 检测） */
function buildRuntimeRecordSignature(node: SnapshotNode): string {
  if (!node || typeof node !== 'object') {
    return ''
  }

  return [
    node.kind || '',
    resolveRuntimeStableText(node),
    node.businessKey || '',
    node.selector || '',
  ].join('|')
}

/** 构建只包含 Agent 可观察语义的视图签名，用于动作前后变化等待。 */
function buildRuntimeViewSignature(nodes: SnapshotNode[]): string {
  const parts: string[] = []
  const visit = (items: SnapshotNode[]): void => {
    for (const node of items || []) {
      parts.push([
        node.kind || node.tagName || '',
        node.businessKey || '',
        node.selector || '',
        Number(node.index || 0),
        normalizeRuntimeText(node.text || ''),
      ].join('|'))
      visit(node.children || [])
    }
  }
  visit(nodes || [])
  return parts.join('\n')
}

/** 在节点树中按 stableKey 查找节点 */
function findNodeByStableKey(nodes: SnapshotNode[], pageKey: string, route: string, stableKey: string): SnapshotNode | null {
  if (!stableKey) {
    return null
  }
  return findFirstNode(nodes, (node) => buildNodeStableKey(pageKey, route, node) === stableKey)
}

/** 计算目标节点在同 selector 节点列表中的索引 */
function selectorIndexInSubtree(nodes: SnapshotNode[], targetNode: SnapshotNode): number {
  if (!targetNode || !targetNode.selector) {
    return 0
  }
  const matches = collectMatchingNodes(nodes, (candidate) => candidate.selector === targetNode.selector)
  return Math.max(matches.indexOf(targetNode), 0)
}

/**
 * 对快照树应用后处理选项。
 * - compact：压缩空容器
 * - depth：限制树深度
 */
function applySnapshotOptions(nodes: SnapshotNode[], options: SnapshotOptions = {}): SnapshotNode[] {
  let nextNodes = nodes || []

  if (options.compact) {
    nextNodes = compactSnapshotNodes(nextNodes)
  }

  if (Number.isFinite(options.depth) && (options.depth ?? 0) > 0) {
    nextNodes = limitSnapshotDepth(nextNodes, options.depth ?? 0)
  }

  return nextNodes
}

// ---- 快照树构建 ----

type SnapshotTimeoutError = Error & {
  code?: string
  hint?: string
  raw?: string
}

async function withRuntimeSnapshotTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`${label} timed out after ${timeoutMs}ms`) as SnapshotTimeoutError
          error.code = 'DEVTOOLS_RENDER_AUTOMATION_TIMEOUT'
          reject(error)
        }, Math.max(1, timeoutMs))
      }),
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

function isRuntimeSnapshotTimeout(error: unknown): boolean {
  return Boolean(error && typeof error === 'object'
    && (error as SnapshotTimeoutError).code === 'DEVTOOLS_RENDER_AUTOMATION_TIMEOUT')
}

function buildRenderAutomationUnavailableError(error: unknown): SnapshotTimeoutError {
  const raw = error instanceof Error ? error.message : String(error)
  const unavailable = new Error(
    'DevTools automation 已连接，但页面元素接口没有响应；当前 DevTools 的渲染侧 automation/ideplugin 未就绪。',
  ) as SnapshotTimeoutError
  unavailable.code = 'DEVTOOLS_RENDER_AUTOMATION_UNAVAILABLE'
  unavailable.hint = '请重启或升级微信开发者工具并重新执行 open；无需替换为生产 AppID。'
  unavailable.raw = raw
  return unavailable
}

/** 根据 outerWxml 中业务键的出现位置推导数据顺序 */
function deriveRuntimeOrder(rootWxml: string, item: SnapshotNode): number {
  if (item.businessKey) {
    const [attributeName, attributeValue] = item.businessKey.split(/:(.+)/u)
    const marker = `${attributeName}="${attributeValue}"`
    const index = rootWxml.indexOf(marker)
    if (index >= 0) {
      return index
    }
  }

  const prefix = String(item.outerWxml || '').slice(0, 120)
  const fallbackIndex = prefix ? rootWxml.indexOf(prefix) : -1
  return fallbackIndex >= 0 ? fallbackIndex : Number.MAX_SAFE_INTEGER
}

/** 采集指定标签名的所有元素并解析为快照项 */
async function collectRuntimeSnapshotItems(page: SnapshotPage, tagName: string, options: SnapshotOptions = {}): Promise<SnapshotNode[]> {
  const queryTimeoutMs = Math.max(1, Number(options.queryTimeoutMs ?? DEFAULT_RUNTIME_SNAPSHOT_QUERY_TIMEOUT_MS))
  const elementTimeoutMs = Math.max(1, Number(options.elementTimeoutMs ?? DEFAULT_RUNTIME_SNAPSHOT_ELEMENT_TIMEOUT_MS))
  const elements = await withRuntimeSnapshotTimeout(
    page.$$(tagName),
    queryTimeoutMs,
    `Page.getElements(${tagName})`,
  )
  const items: SnapshotNode[] = []
  const selectorOccurrences = new Map<string, number>()

  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index]
    let outerWxml = ''
    try {
      outerWxml = await withRuntimeSnapshotTimeout(
        element.outerWxml(),
        elementTimeoutMs,
        `Element.getWXML(${tagName}:${index})`,
      )
    } catch (error: unknown) {
      if (isRuntimeSnapshotTimeout(error)) {
        throw error
      }
    }
    if (!outerWxml) {
      continue
    }

    const { tagName: parsedTagName, attributes } = parseOpeningTagAttributes(outerWxml)
    const resolvedTagName = parsedTagName || element.tagName || tagName
    const selector = deriveRuntimeSelector(resolvedTagName, attributes)
    const selectorIndex = selectorOccurrences.get(selector) || 0
    selectorOccurrences.set(selector, selectorIndex + 1)
    let text = ''
    try {
      text = await withRuntimeSnapshotTimeout(
        element.text(),
        elementTimeoutMs,
        `Element.getDOMProperties(${tagName}:${index})`,
      )
    } catch (error: unknown) {
      if (isRuntimeSnapshotTimeout(error)) {
        throw error
      }
    }
    items.push({
      tagName: resolvedTagName,
      selector,
      index: selectorIndex,
      attributes,
      businessKey: deriveRuntimeBusinessKey(attributes),
      kind: deriveRuntimeKind(resolvedTagName, attributes),
      text: deriveRuntimeText(resolvedTagName, attributes, text, outerWxml),
      rawText: normalizeRuntimeText(text),
      outerWxml,
      children: [],
      parentKey: null,
      order: Number.MAX_SAFE_INTEGER,
    })
  }

  return items
}

/** 通过 outerWxml 层级关系为快照项推导父子关系 */
function attachRuntimeSnapshotParents(items: SnapshotNode[], rootWxml: string): void {
  items.forEach((item, index) => {
    item.runtimeKey = `runtime:${index}`
  })

  for (const item of items) {
    item.order = deriveRuntimeOrder(rootWxml, item)
    const candidates = items
      .filter((candidate) => {
        if (candidate === item || candidate.tagName === 'label' || !candidate.outerWxml || !item.outerWxml) {
          return false
        }

        return (candidate.outerWxml?.length ?? 0) > (item.outerWxml?.length ?? 0)
          && candidate.outerWxml.includes(item.outerWxml)
      })
      .sort((left, right) => (left.outerWxml?.length ?? 0) - (right.outerWxml?.length ?? 0))

    item.parentKey = candidates[0] ? candidates[0].runtimeKey : null
  }
}

/**
 * 将快照项列表构建为精简的语义化树。
 * 包括：排序、剪枝、去冗余、上下文拼接。
 */
function buildRuntimeSnapshotTree(items: SnapshotNode[]): SnapshotNode[] {
  const itemsByKey = new Map()
  const roots: SnapshotNode[] = []

  for (const item of items) {
    item.children = []
    itemsByKey.set(item.runtimeKey || item.businessKey, item)
  }

  for (const item of items) {
    if (item.parentKey && itemsByKey.has(item.parentKey)) {
      const parent = itemsByKey.get(item.parentKey)
      if (parent) {
        parent.children.push(item)
        continue
      }
    }
    roots.push(item)
  }

  const sortNodes = (nodes: SnapshotNode[]): void => {
    nodes.sort((left, right) => (Number(left.order) || 0) - (Number(right.order) || 0))
    for (const node of nodes) {
      sortNodes(node.children || [])
    }
  }

  sortNodes(roots)
  const pruned = flattenNodeGroups(roots.map((item) => pruneRuntimeNode(item, 0)))
  return collapseRedundantTextNodes(enrichRuntimeNodeContext(pruned))
}

/**
 * 将快照项列表构建为原始完整树。
 * 保留所有字段，不改写数据结构。
 */
function buildRawRuntimeTree(items: SnapshotNode[]): SnapshotNode[] {
  const itemsByKey = new Map()
  const roots: SnapshotNode[] = []

  for (const item of items) {
    item.children = []
    itemsByKey.set(item.runtimeKey || item.businessKey, item)
  }

  for (const item of items) {
    if (item.parentKey && itemsByKey.has(item.parentKey)) {
      const parent = itemsByKey.get(item.parentKey)
      if (parent) {
        parent.children.push(item)
        continue
      }
    }
    roots.push(item)
  }

  const sortNodes = (nodes: SnapshotNode[]): void => {
    nodes.sort((left, right) => (Number(left.order) || 0) - (Number(right.order) || 0))
    for (const node of nodes) {
      sortNodes(node.children || [])
    }
  }
  sortNodes(roots)

  const convert = (nodes: SnapshotNode[]): SnapshotNode[] => (nodes || []).map((node) => toRawRuntimeNode(node, convert(node.children || [])))
  return convert(roots)
}

/**
 * 读取页面运行时快照树。
 *
 * 工作流程：
 * 1. 通过种子标签采集初始元素，获取 root outerWxml
 * 2. 从 root WXML 扩展扫描所有标签
 * 3. 去重合并全部元素，推导父子关系
 * 4. 构建为语义化或原始树
 */
async function readRuntimeTree(page: SnapshotPage, options: SnapshotOptions = {}): Promise<{ pageKey: string; nodes: SnapshotNode[] }> {
  const seedItems: SnapshotNode[] = []
  for (const tagName of RUNTIME_SNAPSHOT_SEED_TAGS) {
    try {
      const items = await collectRuntimeSnapshotItems(page, tagName, options)
      seedItems.push(...items)
    } catch (error: unknown) {
      if (isRuntimeSnapshotTimeout(error)) {
        throw buildRenderAutomationUnavailableError(error)
      }
    }
  }

  if (!seedItems.length) {
    return { pageKey: buildDefaultPageKey(page), nodes: [] }
  }

  const rootItem = [...seedItems].sort((left, right) => (right.outerWxml?.length ?? 0) - (left.outerWxml?.length ?? 0))[0]
  if (!rootItem) {
    return { pageKey: buildDefaultPageKey(page), nodes: [] }
  }

  const tagNames = collectTagNamesFromWxml(rootItem.outerWxml || '')
  const allItems: SnapshotNode[] = []
  const seenKeys = new Set()

  for (const tagName of tagNames) {
    let items: SnapshotNode[] = []
    try {
      items = await collectRuntimeSnapshotItems(page, tagName, options)
    } catch (error: unknown) {
      if (isRuntimeSnapshotTimeout(error)) {
        throw buildRenderAutomationUnavailableError(error)
      }
    }
    for (const item of items) {
      const dedupeKey = item.businessKey || `${item.selector}:${item.index}:${item.outerWxml}`
      if (seenKeys.has(dedupeKey)) {
        continue
      }
      seenKeys.add(dedupeKey)
      allItems.push(item)
    }
  }

  if (!allItems.length) {
    return { pageKey: buildDefaultPageKey(page), nodes: [] }
  }

  attachRuntimeSnapshotParents(allItems, rootItem.outerWxml || '')

  return {
    pageKey: buildDefaultPageKey(page),
    nodes: options.raw ? buildRawRuntimeTree(allItems) : buildRuntimeSnapshotTree(allItems),
  }
}

// ---- 节点搜索 ----

/** 判定快照节点是否与记录匹配（基于 strategy 类型） */
function matchesRecord(node: SnapshotNode, record: RefRecordLike): boolean {
  if (!record || !record.strategy) {
    return false
  }

  switch (record.strategy.kind) {
    case 'registry':
      return node.registryId === record.strategy.value
    case 'testid':
      return node.testid === record.strategy.value
    case 'selector':
      return node.selector === record.strategy.selector
    case 'business':
      return node.businessKey === record.strategy.value
    case 'scope':
      return node.scopeKey === record.strategy.value
    default:
      return false
  }
}

/** 在节点树中深度优先查找首个匹配 predicate 的节点 */
function findFirstNode(nodes: SnapshotNode[], predicate: (node: SnapshotNode) => boolean): SnapshotNode | null {
  for (const node of nodes || []) {
    if (predicate(node)) {
      return node
    }
    const child = findFirstNode(node.children || [], predicate)
    if (child) {
      return child
    }
  }
  return null
}

/** 在节点树中收集所有匹配 predicate 的节点 */
function collectMatchingNodes(nodes: SnapshotNode[], predicate: (node: SnapshotNode) => boolean, collected: SnapshotNode[] = []): SnapshotNode[] {
  for (const node of nodes || []) {
    if (predicate(node)) {
      collected.push(node)
    }
    collectMatchingNodes(node.children || [], predicate, collected)
  }
  return collected
}

/**
 * 将快照树限定到 scope 记录指定的子树。
 * 先尝试 stableKey 匹配，fallback 到 records/selector 匹配。
 */
function subtreeForScope(tree: SnapshotNode[], scopeRecord: RefRecordLike | null, pageKey = ''): SnapshotNode[] {
  if (!scopeRecord) {
    return tree
  }

  if (scopeRecord.stableKey) {
    const node = findNodeByStableKey(tree, pageKey, scopeRecord.route || '', scopeRecord.stableKey)
    if (node) {
      return node.children || []
    }
  }

  const node = findFirstNode(tree, (candidate) => matchesRecord(candidate, scopeRecord))
  return node ? node.children || [] : []
}

/** 从 page 对象构建缺省 pageKey */
function buildDefaultPageKey(page: SnapshotPage): string {
  const route = page.path || ''
  const query = page && page.query && typeof page.query === 'object'
    ? Object.entries(page.query)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${value}`)
      .join('&')
    : ''

  return query ? `${route}?${query}` : route
}

/**
 * 递归统计快照树中的节点总数。
 * 支持两种 children 结构：{ children } 和 { nodes }。
 */
function countRuntimeTreeNodes(value: unknown): number {
  if (!value) {
    return 0
  }

  if (Array.isArray(value)) {
    return value.reduce<number>((sum, item) => sum + countRuntimeTreeNodes(item), 0)
  }

  if (typeof value !== 'object') {
    return 0
  }

  const obj = value as { children?: unknown; nodes?: unknown }
  const children = Array.isArray(obj.children)
    ? obj.children
    : Array.isArray(obj.nodes)
      ? obj.nodes
      : []
  return 1 + children.reduce<number>((sum, item) => sum + countRuntimeTreeNodes(item), 0)
}

/**
 * 探测页面视图是否已渲染（通过读取快照树并检查节点数）。
 * 不抛异常，错误通过返回值体现。
 */
async function probeRuntimeViewReady(page: unknown): Promise<{ viewReady: boolean; viewNodeCount: number; viewError?: string }> {
  try {
    const tree = await readRuntimeTree(page as SnapshotPage, { raw: true })
    const nodeCount = countRuntimeTreeNodes(tree && tree.nodes)
    return {
      viewReady: nodeCount > 0,
      viewNodeCount: nodeCount,
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? String(error.message) : String(error)
    return {
      viewReady: false,
      viewNodeCount: 0,
      viewError: message,
    }
  }
}

module.exports = {
  RUNTIME_SNAPSHOT_SEED_TAGS,
  INTERACTIVE_RUNTIME_TAGS,
  CONTENT_RUNTIME_TAGS,
  STRUCTURAL_RUNTIME_TAGS,
  buildDefaultPageKey,
  countRuntimeTreeNodes,
  probeRuntimeViewReady,
  collectTagNamesFromWxml,
  parseOpeningTagAttributes,
  normalizeRuntimeText,
  deriveRuntimeBusinessKey,
  deriveRuntimeSelector,
  deriveRuntimeKind,
  deriveRuntimeText,
  isInteractiveRuntimeNode,
  isContentRuntimeNode,
  isStructuralRuntimeNode,
  toSemanticRuntimeKind,
  toSnapshotNode,
  toRawRuntimeNode,
  enrichRuntimeNodeContext,
  collapseRedundantTextNodes,
  flattenNodeGroups,
  pruneRuntimeNode,
  limitSnapshotDepth,
  compactSnapshotNodes,
  buildCanonicalIdentity,
  assignCanonicalPaths,
  buildNodeStableKey,
  buildRuntimeRecordSignature,
  buildRuntimeViewSignature,
  findNodeByStableKey,
  selectorIndexInSubtree,
  applySnapshotOptions,
  deriveRuntimeOrder,
  collectRuntimeSnapshotItems,
  attachRuntimeSnapshotParents,
  buildRuntimeSnapshotTree,
  buildRawRuntimeTree,
  readRuntimeTree,
  matchesRecord,
  findFirstNode,
  collectMatchingNodes,
  subtreeForScope,
}
