/**
 * runtime-core.ts — 纯格式化/数据转换函数
 *
 * 本模块包含 miniprogram-browser 的纯函数工具集，用于：
 * - 深度序列化运行时数据（循环引用安全）
 * - 规范化控制台/异常/路由事件格式
 * - 格式化事件输出行
 * - 构造点击提示消息
 *
 * 所有函数均为纯函数，不依赖外部状态或 IO。
 */

// ---- 通用序列化 ----

/**
 * 将任意值深度序列化为可 JSON 序列化的纯对象。
 * 处理 cyclic 引用（通过 WeakSet 检测），
 * Error、BigInt、Date 等特殊类型做针对性转换。
 */
function toSerializable(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || value === undefined) {
    return value
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }

  if (typeof value === 'bigint') {
    return String(value)
  }

  if (Array.isArray(value)) {
    return value.map((item) => toSerializable(item, seen))
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    }
  }

  if (typeof value === 'object') {
    if (seen.has(value)) {
      return '[Circular]'
    }
    seen.add(value)
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      result[key] = toSerializable(item, seen)
    }
    seen.delete(value)
    return result
  }

  return String(value)
}

// ---- 事件规范化 ----

function normalizeConsoleEvent(payload: unknown): { ts: number; type: string; args: unknown[]; raw: unknown } {
  const normalized = toSerializable(payload) as Record<string, unknown>
  return {
    ts: Date.now(),
    type: normalized && normalized.type ? String(normalized.type) : 'log',
    args: Array.isArray(normalized && normalized.args) ? (normalized.args as unknown[]) : [],
    raw: normalized,
  }
}

function normalizeExceptionEvent(payload: unknown): { ts: number; message: string; stack: string; raw: unknown } {
  const normalized = toSerializable(payload) as Record<string, unknown>
  return {
    ts: Date.now(),
    message: normalized && normalized.message ? String(normalized.message) : '',
    stack: normalized && normalized.stack ? String(normalized.stack) : '',
    raw: normalized,
  }
}

function normalizeRouteTimelineEvent(payload: unknown): { seq: number; ts: number; kind: string; from: string; to: string; openType: string; message: string } {
  const normalized = (toSerializable(payload) || {}) as Record<string, unknown>
  const from = String(normalized.from || '').replace(/^\//u, '')
  const to = String(normalized.to || '').replace(/^\//u, '')
  const openType = String(normalized.openType || 'route')

  return {
    seq: Number(normalized.seq || 0),
    ts: Number(normalized.ts || Date.now()),
    kind: 'route',
    from,
    to,
    openType,
    message: `${openType} ${from || '(unknown)'} -> ${to || '(unknown)'}`,
  }
}

/**
 * 规范化路由字符串：去掉前导 / 和查询参数。
 * 例如 "/pages/index/index?foo=bar" → "pages/index/index"
 */
function normalizeRuntimeRoute(value: string): string {
  return String(value || '').trim().replace(/^\//u, '').replace(/\?.*$/u, '')
}

// ---- 事件存储 ----

function appendRuntimeEvents(state: { consoleEvents: unknown[]; exceptionEvents: unknown[] }, events: { consoleEvents?: unknown[]; exceptionEvents?: unknown[] }): void {
  state.consoleEvents = [
    ...(Array.isArray(state.consoleEvents) ? state.consoleEvents : []),
    ...(events.consoleEvents || []),
  ]
  state.exceptionEvents = [
    ...(Array.isArray(state.exceptionEvents) ? state.exceptionEvents : []),
    ...(events.exceptionEvents || []),
  ]
}

// ---- 事件格式化 ----

/** 将事件列表通过 formatter 映射为字符串行 */
function formatRuntimeEventLines(events: unknown[], formatter: (event: unknown) => string): string[] {
  return (events || []).map(formatter)
}

/** 格式化 console 事件为单行文本 */
function formatConsoleEventLine(event: { type?: string; args?: unknown[] } | undefined): string {
  const ev = event || {}
  const args = Array.isArray(ev.args) ? ev.args : []
  const text = args.map((item) => {
    if (typeof item === 'string') {
      return item
    }
    return JSON.stringify(item)
  }).join(' ')
  return `${ev.type || 'log'} ${text}`.trim()
}

/** 格式化 exception 事件为单行文本 */
function formatExceptionEventLine(event: { message?: string; raw?: unknown } | undefined): string {
  const message = String(event?.message || '').trim()
  if (message) {
    return message
  }

  return JSON.stringify(event?.raw || {})
}

/** 格式化路由时间线事件为单行文本 */
function formatRouteTimelineLine(event: { message?: string } | undefined): string {
  return String((event && event.message) || '').trim()
}

// ---- 文本工具 ----

/** 规范化运行时文本：合并空白、去前后空格、截断 80 字符 */
function normalizeRuntimeIdentityText(value: string): string {
  return String(value || '').replace(/\s+/gu, ' ').trim().slice(0, 80)
}

/** 从快照节点获取稳定的标识文本 */
function resolveRuntimeStableText(node: Record<string, unknown> | null | undefined): string {
  return normalizeRuntimeIdentityText(node && typeof node === 'object' ? (String(node.identityText || node.text || '')) : '')
}

// ---- 点击反馈 ----

/**
 * 基于路由事件和前后路径构造点击反馈消息行。
 * - 有路由事件时直接输出事件摘要
 * - 前后路径相同 → 提示可能弹窗
 * - 无事件且路径变化 → 空数组
 */
function buildClickNotices({ pathBefore, pathAfter, routeEvents = [] }: { pathBefore?: string; pathAfter?: string; routeEvents?: { message?: string }[] }): string[] {
  if ((routeEvents || []).length > 0) {
    return routeEvents.map(formatRouteTimelineLine)
  }

  if (pathBefore && pathAfter && pathBefore === pathAfter) {
    return ['点击后页面未跳转；如果预期应跳页，请检查是否出现登录/授权弹窗，可尝试 native confirmModal 或查看 timeline/logs。']
  }

  return []
}

module.exports = {
  toSerializable,
  normalizeConsoleEvent,
  normalizeExceptionEvent,
  normalizeRouteTimelineEvent,
  normalizeRuntimeRoute,
  appendRuntimeEvents,
  formatRuntimeEventLines,
  formatConsoleEventLine,
  formatExceptionEventLine,
  formatRouteTimelineLine,
  normalizeRuntimeIdentityText,
  resolveRuntimeStableText,
  buildClickNotices,
}
