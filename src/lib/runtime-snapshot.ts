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

type AnyRecord = Record<string, any>

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
  'swiper-item',
])

// ---- WXML 解析 ----

/**
 * 从 outerWxml 中收集所有标签名。
 * 以种子标签为基线，扩展扫描到页面实际用到的额外标签。
 */
function collectTagNamesFromWxml(wxml) {
  const tags = new Set(RUNTIME_SNAPSHOT_SEED_TAGS)
  const regex = /<([a-zA-Z][\w-]*)\b/gu
  let match

  while ((match = regex.exec(wxml || '')) !== null) {
    tags.add(match[1])
  }

  return [...tags]
}

/**
 * 解析单个 WXML 标签的开始标记，提取标签名和属性字典。
 * 支持双引号、单引号、无引号属性值。
 */
function parseOpeningTagAttributes(outerWxml) {
  const match = String(outerWxml || '').match(/^<([a-zA-Z][\w-]*)([^>]*)>/u)
  if (!match) {
    return { tagName: '', attributes: {} }
  }

  const attributes = {}
  const attrRegex = /([:@a-zA-Z_][\w:.-]*)(?:=("([^"]*)"|'([^']*)'|([^\s>]+)))?/gu
  let attrMatch

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
function normalizeRuntimeText(value) {
  return String(value || '').replace(/\s+/gu, ' ').trim()
}

/**
 * 从 WXML 属性中推导业务键。
 * 优先级：data-sid > id。
 */
function deriveRuntimeBusinessKey(attributes) {
  if (attributes['data-sid']) {
    return `data-sid:${attributes['data-sid']}`
  }

  if (attributes.id) {
    return `id:${attributes.id}`
  }

  return null
}

/** 从标签名和属性推导用于 $$() 的选择器表达式 */
function deriveRuntimeSelector(tagName, attributes) {
  if (attributes.id) {
    return `[id="${String(attributes.id).replace(/(["\\])/gu, '\\$1')}"]`
  }

  if (attributes['data-sid']) {
    return `[data-sid="${attributes['data-sid']}"]`
  }

  return tagName
}

/**
 * 推导节点语义类别（kind）。
 * 优先级：role 属性 > 交互性判断 > 标签名。
 */
function deriveRuntimeKind(tagName, attributes) {
  const role = normalizeRuntimeText(attributes.role)
  if (role) {
    return role
  }

  if (
    tagName === 'view'
    && (attributes['hover-class'] || attributes.bindtap || attributes.catchtap || attributes.bindlongpress)
  ) {
    return 'button'
  }

  return tagName || 'custom'
}

/**
 * 推导需要保留的节点文本。
 * 仅对交互式/内容类标签保留文本，普通容器节点的文本不保留（避免冗余）。
 */
function deriveRuntimeText(tagName, attributes, text) {
  const normalized = normalizeRuntimeText(text)
  if (!normalized) {
    return ''
  }

  if (INTERACTIVE_RUNTIME_TAGS.has(tagName)) {
    return normalized
  }

  if (tagName === 'text' || tagName === 'label') {
    return normalized
  }

  if (attributes['hover-class'] || attributes.bindtap || attributes.catchtap || attributes.role) {
    return normalized
  }

  return ''
}

// ---- 节点类型判定 ----

/** 快照节点是否为可交互元素 */
function isInteractiveRuntimeNode(node) {
  return INTERACTIVE_RUNTIME_TAGS.has(node.kind)
    || node.kind === 'button'
}

/** 快照节点是否为纯内容元素 */
function isContentRuntimeNode(node) {
  return CONTENT_RUNTIME_TAGS.has(node.tagName) && Boolean(normalizeRuntimeText(node.text))
}

/** 快照节点是否为结构容器元素 */
function isStructuralRuntimeNode(node) {
  return STRUCTURAL_RUNTIME_TAGS.has(node.tagName)
}

// ---- 节点转换 ----

/** 将原始节点转换为语义化的精简快照节点 */
function toSemanticRuntimeKind(node, childCount) {
  if (isInteractiveRuntimeNode(node)) {
    return node.kind
  }

  if (isContentRuntimeNode(node)) {
    return node.kind
  }

  if (isStructuralRuntimeNode(node)) {
    return node.tagName
  }

  if (childCount > 0) {
    return node.tagName || 'view'
  }

  return node.kind || 'custom'
}

/** 将原始节点转换为精简快照节点（给模型使用的语义化表示） */
function toSnapshotNode(node, children = []) {
  return {
    businessKey: node.businessKey || undefined,
    selector: node.selector,
    kind: toSemanticRuntimeKind(node, children.length),
    identityText: normalizeRuntimeText(node.text),
    text: isInteractiveRuntimeNode(node) || isContentRuntimeNode(node)
      ? normalizeRuntimeText(node.text)
      : '',
    children,
  }
}

/** 将原始节点转换为包含完整元数据的原始快照节点 */
function toRawRuntimeNode(node, children = []) {
  return {
    businessKey: node.businessKey || undefined,
    selector: node.selector,
    kind: node.kind || node.tagName || 'view',
    tagName: node.tagName || 'view',
    identityText: normalizeRuntimeText(node.text),
    text: normalizeRuntimeText(node.text),
    strategy: {
      kind: 'selector',
      selector: node.selector,
      index: 0,
    },
    children,
  }
}

// ---- 树结构变换 ----

/** 为快照节点继承上下文，将按钮文本与所在 section 标题拼接 */
function enrichRuntimeNodeContext(nodes, inheritedSection = '') {
  const nextNodes = []
  let currentSection = inheritedSection

  for (const node of nodes || []) {
    const text = normalizeRuntimeText(node.text)
    const children = enrichRuntimeNodeContext(node.children || [], currentSection)
    let nextNode = {
      ...node,
      children,
    }

    if (node.kind === 'text' && text && (children.length > 0 || text.length <= 8)) {
      currentSection = text
    }

    if (node.kind === 'button' && currentSection && text && !text.includes(`<${currentSection}>`) && text !== currentSection) {
      nextNode = {
        ...nextNode,
        text: `${text} <${currentSection}>`,
      }
    }

    nextNodes.push(nextNode)
  }

  return nextNodes
}

/** 移除被可交互兄弟节点文本覆盖的冗余文本节点 */
function collapseRedundantTextNodes(nodes) {
  const nextNodes = (nodes || []).map((node) => ({
    ...node,
    children: collapseRedundantTextNodes(node.children || []),
  }))

  return nextNodes.filter((node) => {
    if (node.kind !== 'text') {
      return true
    }

    const text = normalizeRuntimeText(node.text)
    if (!text) {
      return false
    }

    const coveredByClickableSibling = nextNodes.some((sibling) => sibling !== node
      && sibling.kind === 'button'
      && normalizeRuntimeText(sibling.text).includes(text))

    return !coveredByClickableSibling
  })
}

/** 展开节点组数组（支持嵌套数组和空值过滤） */
function flattenNodeGroups(groups) {
  const result = []
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
function pruneRuntimeNode(node, depth = 0) {
  if (isInteractiveRuntimeNode(node)) {
    return [toSnapshotNode(node)]
  }

  if (isContentRuntimeNode(node)) {
    return [toSnapshotNode(node)]
  }

  const children = flattenNodeGroups((node.children || []).map((child) => pruneRuntimeNode(child, depth + 1)))
  if (!children.length) {
    return []
  }

  const shouldKeepContainer = isStructuralRuntimeNode(node) || children.length > 1
  if (!shouldKeepContainer || depth === 0) {
    return children
  }

  return [toSnapshotNode(node, children)]
}

/** 限制快照树最大深度（防止过深的 VDOM 展开） */
function limitSnapshotDepth(nodes, maxDepth, currentDepth = 1) {
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
function compactSnapshotNodes(nodes) {
  const compacted = []

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
function buildCanonicalIdentity(node) {
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
function assignCanonicalPaths(nodes, parentPath = '') {
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
function buildNodeStableKey(pageKey, route, node) {
  if (!node || typeof node !== 'object') {
    return ''
  }

  const stablePath = node.canonicalPath ? String(node.canonicalPath) : ''
  return stablePath ? `${pageKey || route}|${stablePath}` : ''
}

/** 构建节点记录的签名（用于后续 staleness 检测） */
function buildRuntimeRecordSignature(node) {
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

/** 在节点树中按 stableKey 查找节点 */
function findNodeByStableKey(nodes, pageKey, route, stableKey) {
  if (!stableKey) {
    return null
  }
  return findFirstNode(nodes, (node) => buildNodeStableKey(pageKey, route, node) === stableKey)
}

/** 计算目标节点在同 selector 节点列表中的索引 */
function selectorIndexInSubtree(nodes, targetNode) {
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
function applySnapshotOptions(nodes, options: AnyRecord = {}) {
  let nextNodes = nodes || []

  if (options.compact) {
    nextNodes = compactSnapshotNodes(nextNodes)
  }

  if (Number.isFinite(options.depth) && options.depth > 0) {
    nextNodes = limitSnapshotDepth(nextNodes, options.depth)
  }

  return nextNodes
}

// ---- 快照树构建 ----

/** 根据 outerWxml 中业务键的出现位置推导数据顺序 */
function deriveRuntimeOrder(rootWxml, item) {
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
async function collectRuntimeSnapshotItems(page, tagName) {
  const elements = await page.$$(tagName)
  const items = []

  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index]
    const outerWxml = await element.outerWxml().catch(() => '')
    if (!outerWxml) {
      continue
    }

    const { tagName: parsedTagName, attributes } = parseOpeningTagAttributes(outerWxml)
    const resolvedTagName = parsedTagName || element.tagName || tagName
    const text = await element.text().catch(() => '')
    items.push({
      tagName: resolvedTagName,
      selector: deriveRuntimeSelector(resolvedTagName, attributes),
      index,
      attributes,
      businessKey: deriveRuntimeBusinessKey(attributes),
      kind: deriveRuntimeKind(resolvedTagName, attributes),
      text: deriveRuntimeText(resolvedTagName, attributes, text),
      outerWxml,
      children: [],
      parentKey: null,
      order: Number.MAX_SAFE_INTEGER,
    })
  }

  return items
}

/** 通过 outerWxml 层级关系为快照项推导父子关系 */
function attachRuntimeSnapshotParents(items, rootWxml) {
  const withKeys = items.filter((item) => item.businessKey)

  for (const item of items) {
    item.order = deriveRuntimeOrder(rootWxml, item)
    if (!item.businessKey) {
      continue
    }

    const candidates = withKeys
      .filter((candidate) => {
        if (candidate === item) {
          return false
        }

        return candidate.outerWxml.length > item.outerWxml.length
          && candidate.outerWxml.includes(item.businessKey.startsWith('data-sid:')
            ? `data-sid="${item.businessKey.slice('data-sid:'.length)}"`
            : `id="${item.businessKey.slice('id:'.length)}"`)
      })
      .sort((left, right) => left.outerWxml.length - right.outerWxml.length)

    item.parentKey = candidates[0] ? candidates[0].businessKey : null
  }
}

/**
 * 将快照项列表构建为精简的语义化树。
 * 包括：排序、剪枝、去冗余、上下文拼接。
 */
function buildRuntimeSnapshotTree(items) {
  const itemsByKey = new Map()
  const roots = []

  for (const item of items) {
    item.children = []
    if (item.businessKey) {
      itemsByKey.set(item.businessKey, item)
    }
  }

  for (const item of items) {
    if (item.parentKey && itemsByKey.has(item.parentKey)) {
      itemsByKey.get(item.parentKey).children.push(item)
      continue
    }
    roots.push(item)
  }

  const sortNodes = (nodes) => {
    nodes.sort((left, right) => left.order - right.order)
    for (const node of nodes) {
      sortNodes(node.children)
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
function buildRawRuntimeTree(items) {
  const itemsByKey = new Map()
  const roots = []

  for (const item of items) {
    item.children = []
    if (item.businessKey) {
      itemsByKey.set(item.businessKey, item)
    }
  }

  for (const item of items) {
    if (item.parentKey && itemsByKey.has(item.parentKey)) {
      itemsByKey.get(item.parentKey).children.push(item)
      continue
    }
    roots.push(item)
  }

  const sortNodes = (nodes) => {
    nodes.sort((left, right) => left.order - right.order)
    for (const node of nodes) {
      sortNodes(node.children)
    }
  }
  sortNodes(roots)

  const convert = (nodes) => (nodes || []).map((node) => toRawRuntimeNode(node, convert(node.children || [])))
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
async function readRuntimeTree(page, options: AnyRecord = {}) {
  const seedItems = []
  for (const tagName of RUNTIME_SNAPSHOT_SEED_TAGS) {
    const items = await collectRuntimeSnapshotItems(page, tagName).catch(() => [])
    seedItems.push(...items)
  }

  if (!seedItems.length) {
    return null
  }

  const rootItem = [...seedItems].sort((left, right) => right.outerWxml.length - left.outerWxml.length)[0]
  const tagNames = collectTagNamesFromWxml(rootItem.outerWxml)
  const allItems = []
  const seenKeys = new Set()

  for (const tagName of tagNames) {
    const items = await collectRuntimeSnapshotItems(page, tagName).catch(() => [])
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
    return null
  }

  attachRuntimeSnapshotParents(allItems, rootItem.outerWxml)

  return {
    pageKey: buildDefaultPageKey(page),
    nodes: options.raw ? buildRawRuntimeTree(allItems) : buildRuntimeSnapshotTree(allItems),
  }
}

// ---- 节点搜索 ----

/** 判定快照节点是否与记录匹配（基于 strategy 类型） */
function matchesRecord(node, record) {
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
function findFirstNode(nodes, predicate) {
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
function collectMatchingNodes(nodes, predicate, collected = []) {
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
function subtreeForScope(tree, scopeRecord, pageKey = '') {
  if (!scopeRecord) {
    return tree
  }

  if (scopeRecord.stableKey) {
    const node = findNodeByStableKey(tree, pageKey, scopeRecord.route, scopeRecord.stableKey)
    if (node) {
      return node.children || []
    }
  }

  const node = findFirstNode(tree, (candidate) => matchesRecord(candidate, scopeRecord))
  return node ? node.children || [] : []
}

/** 从 page 对象构建缺省 pageKey */
function buildDefaultPageKey(page) {
  const route = page && page.path ? page.path : ''
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
function countRuntimeTreeNodes(value) {
  if (!value) {
    return 0
  }

  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + countRuntimeTreeNodes(item), 0)
  }

  if (typeof value !== 'object') {
    return 0
  }

  const children = Array.isArray(value.children)
    ? value.children
    : Array.isArray(value.nodes)
      ? value.nodes
      : []
  return 1 + children.reduce((sum, item) => sum + countRuntimeTreeNodes(item), 0)
}

/**
 * 探测页面视图是否已渲染（通过读取快照树并检查节点数）。
 * 不抛异常，错误通过返回值体现。
 */
async function probeRuntimeViewReady(page) {
  try {
    const tree = await readRuntimeTree(page, { raw: true })
    const nodeCount = countRuntimeTreeNodes(tree && tree.nodes)
    return {
      viewReady: nodeCount > 0,
      viewNodeCount: nodeCount,
    }
  } catch (error) {
    return {
      viewReady: false,
      viewNodeCount: 0,
      viewError: error && error.message ? String(error.message) : String(error),
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
