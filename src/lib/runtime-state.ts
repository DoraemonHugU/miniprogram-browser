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

type AnyRecord = Record<string, any>

// ---- Refs 映射 ----

/**
 * 用新记录更新 state 的 refs 映射。
 * @param reset true 时先将所有现有 ref 标记为 inactive
 */
function updateStateWithRecords(state, records, reset = false) {
  const refs = { ...(state.refs || {}) }
  const stableKeyToRef = { ...(state.stableKeyToRef || {}) }

  if (reset) {
    for (const ref of Object.keys(refs)) {
      refs[ref] = {
        ...refs[ref],
        active: false,
      }
    }
  }

  for (const record of records) {
    refs[record.ref] = {
      ...(refs[record.ref] || {}),
      ...record,
      active: true,
      lastSeenEpoch: state.epoch,
    }

    if (record.stableKey) {
      stableKeyToRef[record.stableKey] = record.ref
    }
  }

  const nextRefIndex = Math.max(
    Number(state.nextRefIndex || 1),
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
function ensureNextRefIndex(state, nextRefIndex) {
  return {
    ...state,
    nextRefIndex: Math.max(Number(state.nextRefIndex || 1), Number(nextRefIndex || 1)),
  }
}

/** 递增 epoch 计数器，用于标记 snapshot 世代 */
function nextEpoch(state) {
  return Number(state.epoch || 0) + 1
}

/** 判定 token 是否为 ref 格式（@e 开头 + 数字） */
function isRefToken(value) {
  return /^@e\d+$/u.test(value)
}

// ---- 事件存储 ----

/**
 * 从 state 查询运行事件列表。
 * @param kind 'exception' 或其他（console）
 * @param options.limit 最大返回条数
 */
function getStoredRuntimeEvents(state, kind, options: AnyRecord = {}) {
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
function clearStoredRuntimeEvents(state, kind) {
  if (kind === 'exception') {
    state.exceptionEvents = []
    return
  }
  state.consoleEvents = []
}

/** 从 state 查询路由时间线 */
function getStoredRouteTimeline(state, options: AnyRecord = {}) {
  const events = Array.isArray(state.routeEvents) ? state.routeEvents : []
  const limit = Number(options.limit || 20)
  if (!Number.isFinite(limit) || limit <= 0) {
    return events
  }
  return events.slice(-limit)
}

/** 清空路由时间线 */
function clearStoredRouteTimeline(state) {
  state.routeEvents = []
}

/** 从 currentPage 结果中同步当前路由到 state */
async function syncCurrentRoute(state, miniProgram) {
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
function normalizeQueryForSignature(query) {
  if (!query || typeof query !== 'object') {
    return ''
  }

  return Object.keys(query)
    .sort()
    .map((key) => `${key}=${String(query[key])}`)
    .join('&')
}

/** 构建页面栈的稳定签名，用于检测页面栈是否发生变化 */
function buildPageStackSignature(stack = []) {
  return (stack || [])
    .map((item) => `${normalizeRuntimeRoute(item && item.path ? item.path : '')}?${normalizeQueryForSignature(item && item.query)}`)
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
