/**
 * runtime-resolve.ts — 引用解析与查询
 *
 * 本模块包含 miniprogram-browser 的 ref 解析和 snapshot 查询功能：
 * - resolveRecord：按 record 解析 DOM 元素（支持 stableKey / strategy 匹配）
 * - resolveTarget：按 token（@eN 或 CSS selector）解析目标元素
 * - snapshotInteractive：交互式 snapshot，返回带 ref 的记录
 * - queryRecords：按模式（selector/text/business）查询元素
 */

const {
  buildTreeSnapshotRecords,
  createRefRecordFromNode,
  formatSnapshotLines,
} = require('./core')
const {
  readRuntimeTree,
  applySnapshotOptions,
  subtreeForScope,
  assignCanonicalPaths,
  matchesRecord,
  findFirstNode,
  findNodeByStableKey,
  selectorIndexInSubtree,
  buildRuntimeRecordSignature,
} = require('./runtime-snapshot')
const {
  updateStateWithRecords,
  ensureNextRefIndex,
  nextEpoch,
  isRefToken,
} = require('./runtime-state')
const {
  resolveRuntimeStableText,
} = require('./runtime-core')

type AnyRecord = Record<string, unknown>

/** 带查询方法的页面/元素句柄（仅用于本模块内部 $/$$ 调用） */
interface PageHandle {
  $(selector: string): Promise<unknown>
  $$(selector: string): Promise<unknown[]>
  [key: string]: unknown
}

/**
 * 根据 ref record 在页面中解析 DOM 元素。
 *
 * 解析策略：
 * 1. 如果 record 有 stableKey，先通过稳定键匹配
 * 2. 否则通过 strategy 类型匹配（selector/registry/testid/business/scope）
 * 3. 如果匹配到节点但签名变化，报告 stale
 * 4. 最终通过 scope.$$(selector)[index] 获取元素
 */
async function resolveRecord(page: AnyRecord, state: AnyRecord, record: AnyRecord, seen: Set<string> = new Set()): Promise<AnyRecord> {
  if (!record || !record.strategy) {
    throw new Error('Invalid ref record')
  }

  if (record.route && page.path && record.route !== page.path) {
    throw new Error(`Ref route mismatch: ${record.ref} belongs to ${record.route}, current page is ${page.path}`)
  }

  const recordRef = String(record.ref || '')
  if (seen.has(recordRef)) {
    throw new Error(`Cyclic ref dependency: ${recordRef}`)
  }

  seen.add(recordRef)

  let scope = page
  const recordScopeRef = record.scopeRef ? String(record.scopeRef) : null
  if (recordScopeRef) {
    const scopeRecord = (state.refs as Record<string, AnyRecord | undefined>)[recordScopeRef]
    if (!scopeRecord) {
      throw new Error(`Missing scope ref: ${recordScopeRef}`)
    }
    scope = await resolveRecord(page, state, scopeRecord, seen)
  }

  const strategy = record.strategy as AnyRecord
  let selector = String(strategy.selector || '')
  let index = Number(strategy.index || 0)
  let matchedNode: AnyRecord | null = null
  const needsFreshTree = Boolean(record.stableKey)
    || !selector
    || ['registry', 'testid', 'business', 'scope'].includes(String(strategy.kind))

  if (needsFreshTree) {
    const treeData = await readRuntimeTree(page)
    const canonicalTree = assignCanonicalPaths(treeData ? treeData.nodes : [])
    const pageKey = treeData ? treeData.pageKey : ''
    const scopeTree = recordScopeRef
      ? subtreeForScope(canonicalTree, (state.refs as Record<string, AnyRecord | undefined>)[recordScopeRef], pageKey)
      : canonicalTree

    matchedNode = findNodeByStableKey(scopeTree, pageKey, String(page.path || ''), String(record.stableKey || ''))
    const matchedByStableKey = Boolean(matchedNode)
    if (!matchedNode) {
      matchedNode = findFirstNode(scopeTree, (candidate: AnyRecord) => matchesRecord(candidate, record))
    }

    if (!matchedNode) {
      throw new Error(`Ref is stale or no longer resolvable: ${recordRef}; page likely changed, run snapshot -i again.`)
    }

    const currentSignature = buildRuntimeRecordSignature(matchedNode)
    if (!matchedByStableKey && record.signature && currentSignature && record.signature !== currentSignature) {
      throw new Error(`Ref is stale: ${recordRef} no longer points to the same UI element; run snapshot -i again.`)
    }

    selector = String((matchedNode as AnyRecord).selector || selector)
    index = selectorIndexInSubtree(scopeTree, matchedNode)
  }

  if (!selector) {
    throw new Error(`Ref is not resolvable without selector: ${recordRef}; run snapshot -i again.`)
  }

  const elements = await (scope as unknown as PageHandle).$$(selector) as AnyRecord[]
  if (matchedNode && elements.length > 1) {
    const stableText = resolveRuntimeStableText(matchedNode)
    if (stableText) {
      for (let candidateIndex = 0; candidateIndex < elements.length; candidateIndex += 1) {
        const elementText = await (elements[candidateIndex] as unknown as { text(): Promise<string> }).text().catch(() => '')
        const candidateText = resolveRuntimeStableText({ text: elementText } as AnyRecord)
        if (candidateText === stableText) {
          index = candidateIndex
          break
        }
      }
    }
  }
  if (elements.length <= index) {
    throw new Error(`Resolved selector not found: ${selector} at index ${index}; page likely changed, run snapshot -i again.`)
  }

  return elements[index]
}

/**
 * 按 token 或 CSS selector 在页面中解析目标元素。
 * - @eN 格式的 token 按 ref 解析
 * - 其他直接作为 CSS selector 使用 scope.$(token)
 */
async function resolveTarget(page: AnyRecord, state: AnyRecord, token: string, scopeRef: string | null = null): Promise<AnyRecord> {
  if (isRefToken(token)) {
    const record = (state.refs as Record<string, AnyRecord | undefined>)[token]
    if (!record) {
      throw new Error(`Unknown ref: ${token}`)
    }
    return resolveRecord(page, state, record)
  }

  let scope = page
  if (scopeRef) {
    const scopeRecord = (state.refs as Record<string, AnyRecord | undefined>)[scopeRef]
    if (!scopeRecord) {
      throw new Error(`Unknown scope ref: ${scopeRef}`)
    }
    scope = await resolveRecord(page, state, scopeRecord)
  }

  const element = await (scope as unknown as PageHandle).$(token) as AnyRecord | null
  if (!element) {
    throw new Error(`Selector not found: ${token}`)
  }
  return element
}

/**
 * 交互式快照：重建页面 ref 映射，返回带 ref 的 snapshot 记录。
 *
 * 工作流程：
 * 1. 读取运行时快照树
 * 2. 分配规范路径和 stableKey
 * 3. 通过 buildTreeSnapshotRecords 构造 ref 记录
 * 4. 更新 state refs 映射
 * 5. 可选应用 snapshotOptions（compact/depth）
 */
async function snapshotInteractive(page: AnyRecord, state: AnyRecord, scopeRef: string | null = null, snapshotOptions: AnyRecord = {}): Promise<AnyRecord> {
  const treeData = await readRuntimeTree(page)
  if (!treeData) {
    throw new Error('No snapshot tree available for snapshot -i')
  }
  const scopeRecord = scopeRef ? (state.refs as Record<string, AnyRecord>)[scopeRef] : null
  const epoch = nextEpoch(state)
  const subtree = assignCanonicalPaths(subtreeForScope(treeData.nodes, scopeRecord))

  const canonicalResult = buildTreeSnapshotRecords({
    nodes: subtree,
    epoch,
    route: page.path,
    pageKey: treeData.pageKey,
    scopeRef,
    startIndex: 1,
    previousState: {
      nextRefIndex: state.nextRefIndex,
      stableKeyToRef: state.stableKeyToRef,
    },
  })

  const nextState = updateStateWithRecords({
    ...state,
    epoch,
    route: page.path,
  }, canonicalResult.records, true)
  const visibleNodes = applySnapshotOptions(subtree, snapshotOptions)
  const visibleResult = buildTreeSnapshotRecords({
    nodes: visibleNodes,
    epoch,
    route: page.path,
    pageKey: treeData.pageKey,
    scopeRef,
    startIndex: 1,
    previousState: {
      nextRefIndex: nextState.nextRefIndex,
      stableKeyToRef: nextState.stableKeyToRef,
    },
  })

  return {
      state: ensureNextRefIndex(nextState, canonicalResult.nextIndex),
      records: visibleResult.records,
      lines: formatSnapshotLines(visibleResult.records),
  }
}

/**
 * 按模式查询页面元素。
 *
 * 模式：
 * - selector：直接通过 CSS selector 查询
 * - text：按文本内容过滤（使用快照树文本匹配）
 * - business：按 businessKey 过滤
 */
async function queryRecords(page: AnyRecord, state: AnyRecord, mode: string, value: string, scopeRef: string | null = null): Promise<AnyRecord> {
  const epoch = Number(state.epoch || 0)
  const route = page.path
  const startIndex = state.nextRefIndex || 1

  if (mode === 'selector') {
    const scope = scopeRef ? await resolveRecord(page, state, (state.refs as Record<string, AnyRecord>)[scopeRef] || {}) : page
    const elements = await (scope as unknown as PageHandle).$$(value) as AnyRecord[]
    const records: AnyRecord[] = []
    for (let index = 0; index < elements.length; index += 1) {
      const element = elements[index] as AnyRecord
      records.push({
        ref: `@e${Number(startIndex) + index}`,
        epoch,
        route,
        parentRef: null,
        scopeRef,
        strategy: {
          kind: 'selector',
          value,
          selector: value,
          index,
        },
        registryId: null,
        testid: null,
        selector: value,
        kind: ((element as unknown as { tagName?: string }).tagName) || 'custom',
        text: await (element as unknown as { text(): Promise<string> }).text().catch(() => ''),
      })
    }

    return {
      records,
      state: updateStateWithRecords(state, records, false),
      lines: formatSnapshotLines(records),
    }
  }

  if (!['text', 'business'].includes(mode)) {
    throw new Error(`Unsupported query mode: ${mode}. Use selector, text, or business.`)
  }

  const treeData = await readRuntimeTree(page)
  if (!treeData) {
    throw new Error(`No snapshot tree available for query mode: ${mode}`)
  }

  const scopeRecord = scopeRef ? (state.refs as Record<string, AnyRecord>)[scopeRef] : null
  const subtree = subtreeForScope(treeData.nodes, scopeRecord)
  const predicate = (node: AnyRecord) => {
    if (mode === 'text') {
      return String(node.text || '').includes(value)
    }
    if (mode === 'business') {
      return node.businessKey === value
    }
    return false
  }

  const built = buildTreeSnapshotRecords({
    nodes: subtree,
    epoch,
    route,
    pageKey: treeData.pageKey,
    scopeRef,
    startIndex,
    previousState: {
      nextRefIndex: state.nextRefIndex,
      stableKeyToRef: state.stableKeyToRef,
    },
  })

  const records = built.records.filter((record: AnyRecord) => {
    if (mode === 'text') {
      return String(record.text || '').includes(value)
    }
    if (mode === 'business') {
      return record.businessKey === value
    }
    return false
  })

  const nextState = ensureNextRefIndex(updateStateWithRecords(state, records, false), built.nextIndex)

  return {
    records,
    state: nextState,
    lines: formatSnapshotLines(records),
  }
}

module.exports = {
  resolveRecord,
  resolveTarget,
  snapshotInteractive,
  queryRecords,
}
