/**
 * runtime-state.ts — 状态管理相关函数
 *
 * 本模块包含 miniprogram-browser 的运行时状态管理：
 * - state 的 refs 映射更新与维护
 * - 事件/时间线存储的读写操作
 * - 路由栈签名等辅助函数
 *
 * 所有函数均对 state 对象进行纯操作或简单读写。
 */

const { normalizeRuntimeRoute } = require('./runtime-core')

// ---- Refs 映射 ----

interface UpdateRecord {
  ref?: string
  stableKey?: string
  kind?: string
  text?: string
  [key: string]: unknown
}

interface RefEntry {
  active?: boolean
  lastSeenEpoch?: number
  [key: string]: unknown
}

interface UpdateStateInput {
  refs: Record<string, RefEntry>
  stableKeyToRef: Record<string, string>
  epoch: number
  nextRefIndex: number
  lastSnapshot: unknown[]
}

/**
 * 用新记录更新 state 的 refs 映射。
 * @param reset true 时用当前 snapshot 世代完整替换旧 refs
 */
function updateStateWithRecords(
  state: UpdateStateInput,
  records: UpdateRecord[],
  reset = false,
): {
  refs: Record<string, RefEntry>
  stableKeyToRef: Record<string, string>
  nextRefIndex: number
  lastSnapshot: { ref: unknown; kind: unknown; text: unknown }[]
} {
  const refs = (reset ? {} : { ...(state.refs || {}) }) as Record<string, RefEntry>
  const stableKeyToRef = reset ? {} : { ...(state.stableKeyToRef || {}) }

  for (const record of records) {
    const recordRef = record.ref || ''
    if (!recordRef) {
      continue
    }
    refs[recordRef] = {
      ...(refs[recordRef] || {}),
      ...record,
      active: true,
      lastSeenEpoch: state.epoch,
    }

    if (record.stableKey) {
      stableKeyToRef[record.stableKey] = recordRef
    }
  }

  const nextRefIndex = Math.max(
    reset ? 1 : Number(state.nextRefIndex || 1),
    ...records.map((record) => Number(String(record.ref || '').replace('@e', '')) + 1).filter(Number.isFinite),
  )

  return {
    ...state,
    refs,
    stableKeyToRef,
    nextRefIndex,
    lastSnapshot: records.map((record) => ({
      ref: record.ref,
      kind: record.kind,
      text: record.text,
    })),
  }
}

/**
 * 确保 state 的 nextRefIndex 不低于给定值。
 * 在多个异步 snapshot 操作间同步索引时使用。
 */
function ensureNextRefIndex(state: Record<string, unknown>, nextRefIndex: number): Record<string, unknown> {
  return {
    ...state,
    nextRefIndex: Math.max(Number(state.nextRefIndex || 1), Number(nextRefIndex || 1)),
  }
}

/** 递增 epoch 计数器，用于标记 snapshot 世代 */
function nextEpoch(state: Record<string, unknown>): number {
  return Number(state.epoch || 0) + 1
}

function isRefToken(value: string): boolean {
  return /^@e\d+$/u.test(value)
}

// ---- 事件存储 ----

/**
 * 从 state 查询运行事件列表。
 * @param kind 'exception' 或其他（console）
 * @param options.limit 最大返回条数
 */
function getStoredRuntimeEvents(state: Record<string, unknown>, kind: string, options: Record<string, unknown> = {}): unknown[] {
  const source = kind === 'exception'
    ? state.exceptionEvents
    : state.consoleEvents
  const events = Array.isArray(source) ? source : []
  const limit = Number(options.limit || 50)
  if (!Number.isFinite(limit) || limit <= 0) {
    return events
  }
  return events.slice(-limit)
}

/** 清空指定类型的运行时事件 */
function clearStoredRuntimeEvents(state: Record<string, unknown>, kind: string): void {
  if (kind === 'exception') {
    state.exceptionEvents = []
    return
  }
  state.consoleEvents = []
}

/** 从 state 查询路由时间线 */
function getStoredRouteTimeline(state: Record<string, unknown>, options: Record<string, unknown> = {}): unknown[] {
  const events = Array.isArray(state.routeEvents) ? state.routeEvents : []
  const limit = Number(options.limit || 20)
  if (!Number.isFinite(limit) || limit <= 0) {
    return events
  }
  return events.slice(-limit)
}

/** 清空路由时间线 */
function clearStoredRouteTimeline(state: Record<string, unknown>): void {
  state.routeEvents = []
}

/** 从 currentPage 结果中同步当前路由到 state */
async function syncCurrentRoute(state: Record<string, unknown>, miniProgram: Record<string, unknown>): Promise<void> {
  if (!state || !miniProgram || typeof miniProgram.currentPage !== 'function') {
    return
  }

  try {
    const page = await miniProgram.currentPage()
    state.route = page && page.path ? String(page.path) : ''
  } catch (_) {
  }
}

// ---- 路由签名 ----

/** 规范化 query 对象为稳定字符串表示（用于签名比较） */
function normalizeQueryForSignature(query: Record<string, unknown> | null | undefined): string {
  if (!query || typeof query !== 'object') {
    return ''
  }

  return Object.keys(query)
    .sort()
    .map((key) => `${key}=${String(query[key])}`)
    .join('&')
}

/** 构建页面栈的稳定签名，用于检测页面栈是否发生变化 */
function buildPageStackSignature(stack: { path?: string; query?: Record<string, unknown> }[] = []): string {
  return (stack || [])
    .map((item) => `${normalizeRuntimeRoute(item.path || '')}?${normalizeQueryForSignature(item.query || null)}`)
    .join('>')
}

module.exports = {
  updateStateWithRecords,
  ensureNextRefIndex,
  nextEpoch,
  isRefToken,
  getStoredRuntimeEvents,
  clearStoredRuntimeEvents,
  getStoredRouteTimeline,
  clearStoredRouteTimeline,
  syncCurrentRoute,
  normalizeQueryForSignature,
  buildPageStackSignature,
}
