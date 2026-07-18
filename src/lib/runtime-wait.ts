/**
 * runtime-wait.ts — 等待/条件/超时相关函数
 *
 * 本模块包含 miniprogram-browser 的等待机制：
 * - 条件解析（normalizeAwaitCondition）
 * - 超时计算（resolveAwaitTimeoutMs）
 * - 日志摘要提取（辅助诊断）
 * - 等待稳定/条件满足轮询
 * - native 诊断消息构造
 */

const {
  normalizeRuntimeRoute,
  resolveRuntimeStableText,
  formatRouteTimelineLine,
} = require('./runtime-core')
const {
  buildPageStackSignature,
} = require('./runtime-state')
const {
  probeRuntimeViewReady,
} = require('./runtime-snapshot')
const {
  getCurrentPage,
  getPageStack,
} = require('./runtime-bridge')

type AnyRecord = Record<string, any>
type ErrorWithMeta = Error & AnyRecord

// ---- 常量 ----

const ROUTE_TIMELINE_LIMIT = 200
const DEFAULT_AWAIT_TIMEOUTS: Record<string, number> = {
  'tool-ready': 30000,
  'app-ready': 90000,
  stable: 15000,
  route: 8000,
  'route-change': 8000,
  'route-settled': 8000,
  selector: 12000,
  visible: 12000,
  hidden: 12000,
  ref: 12000,
}

// ---- 条件解析 ----

/**
 * 解析 await 条件字符串为标准化的条件对象。
 *
 * 支持格式：
 * - 内置类型：tool-ready, app-ready, stable, route-change, route-settled, auto
 * - route:/pages/xxx、selector:.xxx、visible:.xxx、hidden:.xxx
 * - @e1（ref 引用）
 * - /pages/xxx（直接路由）
 */
function normalizeAwaitCondition(rawValue) {
  const raw = String(rawValue || '').trim()
  if (!raw) {
    const error = new Error('await requires a condition, e.g. app-ready or route:/pages/index/index') as ErrorWithMeta
    error.code = 'CLI_USAGE_ERROR'
    throw error
  }

  const builtInKinds = new Set(['tool-ready', 'app-ready', 'stable', 'route-change', 'route-settled', 'auto'])
  if (builtInKinds.has(raw)) {
    return {
      kind: raw,
      value: '',
      raw,
    }
  }

  const colonIndex = raw.indexOf(':')
  if (colonIndex > 0) {
    const kind = raw.slice(0, colonIndex).trim()
    const nextValue = raw.slice(colonIndex + 1).trim()
    if (['route', 'selector', 'visible', 'hidden', 'ref'].includes(kind) && nextValue) {
      return {
        kind,
        value: kind === 'route' ? normalizeRuntimeRoute(nextValue) : nextValue,
        raw,
      }
    }
  }

  if (raw.startsWith('@')) {
    return { kind: 'ref', value: raw, raw }
  }

  if (raw.startsWith('/') || raw.startsWith('pages/')) {
    return { kind: 'route', value: normalizeRuntimeRoute(raw), raw }
  }

  const error = new Error(`Unsupported await condition: ${raw}`) as ErrorWithMeta
  error.code = 'CLI_USAGE_ERROR'
  throw error
}

// ---- 超时计算 ----

/** 从条件和显式超时计算实际超时毫秒数 */
function resolveAwaitTimeoutMs(condition, explicitTimeout) {
  const numericTimeout = Number(explicitTimeout)
  if (Number.isFinite(numericTimeout) && numericTimeout > 0) {
    return numericTimeout
  }

  const kind = condition && condition.kind ? String(condition.kind) : ''
  return DEFAULT_AWAIT_TIMEOUTS[kind] || 12000
}

/**
 * 构造超时错误，附加 hint 和可选的 log/next 信息。
 * 用于 await 超时后的用户友好错误提示。
 */
function buildAwaitTimeoutError(condition, timeoutMs, hint, details: AnyRecord = {}) {
  const error = new Error(`await ${condition.raw} timed out after ${timeoutMs}ms`) as ErrorWithMeta
  error.code = 'AWAIT_TIMEOUT'
  if (hint) {
    error.hint = hint
  }
  if (details.log) {
    error.log = details.log
  }
  if (details.next) {
    error.next = details.next
  }
  return error
}

/** 构造运行时不稳定的超时错误 */
function buildRuntimeStableTimeoutError(timeoutMs, hint, details: AnyRecord = {}) {
  const error = new Error(`runtime stable timed out after ${timeoutMs}ms`) as ErrorWithMeta
  error.code = 'RUNTIME_UNSTABLE'
  error.runtimeMayContinue = true
  error.hint = hint || 'phase=stable'
  error.diagnostics = details
  error.next = 'await stable'
  return error
}

// ---- 日志摘要提取 ----

/**
 * 从 log payload 中提取最有用的一行摘要。
 * 优先匹配已知的 DevTools 错误模式，否则取首行。
 */
function extractLogSummary(logPayload, options: AnyRecord = {}) {
  const maxLength = Math.max(40, Number(options.maxLength || 200))
  let fallback = ''
  for (const file of (logPayload && logPayload.files) || []) {
    const lines = []
    for (const line of file.lines || []) {
      const text = String(line || '').trim()
      if (text) {
        lines.push(text)
      }
    }
    if (!fallback && lines.length) {
      fallback = lines[0]
    }
    const preferred = selectLogSummaryLine(lines)
    if (preferred) {
      return truncateLogSummaryLine(preferred, maxLength)
    }
  }

  if (!fallback) {
    return ''
  }
  return truncateLogSummaryLine(fallback, maxLength)
}

/** 从日志行列表中按优先级选择最佳摘要行 */
function selectLogSummaryLine(lines) {
  const ranked = lines
    .map((line, index) => ({ line, index, score: scoreLogSummaryLine(line) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
  return ranked.length ? ranked[0].line : ''
}

/** 截断过长的日志行 */
function truncateLogSummaryLine(line, maxLength) {
  if (line.length <= maxLength) {
    return line
  }
  return `${line.slice(0, maxLength - 3)}...`
}

/** 为日志行打分（高优先级匹配已知错误模式） */
function scoreLogSummaryLine(line) {
  const text = String(line || '')
  if (/simulator launch catch error|MinTabbarCount|checkTabbar|checkAppJSON/iu.test(text)) {
    return 110
  }
  if (/start cli server error/iu.test(text)) {
    return 100
  }
  if (/routeTo appLaunch timeout|triggerAppRouteDone timeout/iu.test(text)) {
    return 90
  }
  if (/tcp_socket_win\.cc.*10055|connect failed:\s*10055/iu.test(text)) {
    return 85
  }
  if (/error|fail|timeout|errcode|exception/iu.test(text)) {
    return 10
  }
  return 0
}

// ---- 等待条件轮询 ----

/**
 * 执行 await 条件轮询，支持多种条件类型。
 *
 * 条件处理：
 * - tool-ready / app-ready：立即返回成功
 * - route：等待 path 匹配
 * - route-change：等待 path 变化
 * - route-settled：等待 path 连续 2 次不变
 * - selector / visible / hidden：通过 $$ 查询
 * - ref：通过 resolveTarget 检查 ref 可解析
 */
async function waitForMiniProgramCondition(miniProgram, state, condition, options: AnyRecord = {}) {
  if (condition.kind === 'stable') {
    return await waitForMiniProgramStable(miniProgram, {
      timeoutMs: options.timeoutMs || options.timeout,
      pollMs: options.pollMs,
      sleepFn: options.sleepFn,
    })
  }

  const timeoutMs = resolveAwaitTimeoutMs(condition, options.timeoutMs || options.timeout)
  const pollMs = Math.max(1, Number(options.pollMs || 200))
  const sleepFn = options.sleepFn || sleep
  const initialRoute = normalizeRuntimeRoute(options.pathBefore || state.route || '')
  const startedAt = Date.now()
  let lastHint = `kind=${condition.kind}`
  let lastPath = initialRoute
  let stablePath = ''
  let stableCount = 0

  while (Date.now() - startedAt <= timeoutMs) {
    const page = await getCurrentPage(miniProgram)
    const currentPath = normalizeRuntimeRoute(page && page.path ? page.path : '')
    lastPath = currentPath

    if (condition.kind === 'tool-ready' || condition.kind === 'app-ready') {
      return { ok: true, condition, path: currentPath, elapsedMs: Date.now() - startedAt }
    } else if (condition.kind === 'route') {
      if (currentPath === condition.value) {
        return { ok: true, condition, path: currentPath, elapsedMs: Date.now() - startedAt }
      }
      lastHint = `kind=route; current=${currentPath || '(empty)'}`
    } else if (condition.kind === 'route-change') {
      if (initialRoute && currentPath && currentPath !== initialRoute) {
        return { ok: true, condition, path: currentPath, elapsedMs: Date.now() - startedAt }
      }
      lastHint = `kind=route-change; current=${currentPath || '(empty)'}`
    } else if (condition.kind === 'route-settled') {
      if (currentPath && currentPath === stablePath) {
        stableCount += 1
      } else {
        stablePath = currentPath
        stableCount = currentPath ? 1 : 0
      }
      if (stableCount >= 2) {
        return { ok: true, condition, path: currentPath, elapsedMs: Date.now() - startedAt }
      }
      lastHint = `kind=route-settled; current=${currentPath || '(empty)'}`
    } else if (condition.kind === 'selector' || condition.kind === 'visible' || condition.kind === 'hidden') {
      const matches = await page.$$(condition.value)
      const visibleCount = await countVisibleElements(matches)
      if (condition.kind === 'selector' && matches.length > 0) {
        return { ok: true, condition, path: currentPath, elapsedMs: Date.now() - startedAt, count: matches.length }
      }
      if (condition.kind === 'visible' && visibleCount > 0) {
        return { ok: true, condition, path: currentPath, elapsedMs: Date.now() - startedAt, count: visibleCount }
      }
      if (condition.kind === 'hidden' && visibleCount === 0) {
        return { ok: true, condition, path: currentPath, elapsedMs: Date.now() - startedAt, count: 0 }
      }
      lastHint = `kind=${condition.kind}; matches=${condition.kind === 'selector' ? matches.length : visibleCount}`
    } else if (condition.kind === 'ref') {
      try {
        const { resolveTarget } = require('./runtime')
        await resolveTarget(page, state, condition.value, options.scopeRef || null)
        return { ok: true, condition, path: currentPath, elapsedMs: Date.now() - startedAt }
      } catch (_) {
        lastHint = `kind=ref; target=${condition.value}`
      }
    } else {
      const error = new Error(`Unsupported await condition kind: ${condition.kind}`) as ErrorWithMeta
      error.code = 'CLI_USAGE_ERROR'
      throw error
    }

    await sleepFn(pollMs)
  }

  throw buildAwaitTimeoutError(condition, timeoutMs, lastHint, {
    path: lastPath,
  })
}

/** 统计元素列表中可见元素数量（通过 size 检测） */
async function countVisibleElements(elements) {
  let visibleCount = 0
  for (const element of elements || []) {
    try {
      if (typeof element.size === 'function') {
        const size = await element.size()
        if (Number(size && size.width) > 0 || Number(size && size.height) > 0) {
          visibleCount += 1
          continue
        }
      } else {
        visibleCount += 1
        continue
      }
    } catch (_) {
      visibleCount += 1
      continue
    }
  }
  return visibleCount
}

// ---- 稳定等待 ----

/** 采集当前页面栈的稳定快照样本 */
async function readStableRuntimeSample(miniProgram) {
  const page = await getCurrentPage(miniProgram)
  const pathValue = normalizeRuntimeRoute(page && page.path ? page.path : '')
  let stack = []
  try {
    stack = await getPageStack(miniProgram)
  } catch (_) {
    stack = pathValue ? [{ path: pathValue, query: {} }] : []
  }

  const stackSignature = buildPageStackSignature(stack)
  return {
    page,
    path: pathValue,
    pageStackDepth: stack.length,
    signature: `${pathValue}|${stackSignature}`,
  }
}

/**
 * 等待小程序运行稳定（路由不再变化）。
 *
 * 轮询页面栈签名，在 quietMs 毫秒内无变化则视为稳定。
 * 可选进行视图预制探针检查。
 */
async function waitForMiniProgramStable(miniProgram, options: AnyRecord = {}) {
  const timeoutMs = Math.max(1, Number(options.timeoutMs ?? options.timeout ?? DEFAULT_AWAIT_TIMEOUTS.stable))
  const quietMs = Math.max(0, Number(options.quietMs ?? 1200))
  const pollMs = Math.max(1, Number(options.pollMs ?? 300))
  const sleepFn = options.sleepFn || sleep
  const startedAt = Date.now()
  let lastSignature = ''
  let stableSince = 0
  let lastSample = null
  let lastHint = 'phase=stable'

  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const sample = await readStableRuntimeSample(miniProgram)
      lastSample = sample

      if (!sample.path) {
        lastHint = 'phase=stable; current=(empty)'
        lastSignature = ''
        stableSince = 0
      } else if (sample.signature !== lastSignature) {
        lastSignature = sample.signature
        stableSince = Date.now()
        lastHint = `phase=stable; current=${sample.path}`
        if (quietMs === 0) {
          break
        }
      } else {
        const stableMs = Date.now() - stableSince
        lastHint = `phase=stable; current=${sample.path}; stableMs=${stableMs}`
        if (stableMs >= quietMs) {
          break
        }
      }
    } catch (error) {
      lastHint = `phase=stable; error=${error && error.message ? String(error.message) : String(error)}`
      lastSignature = ''
      stableSince = 0
    }

    await sleepFn(pollMs)
  }

  if (!lastSample || !lastSample.path || (quietMs > 0 && Date.now() - stableSince < quietMs)) {
    throw buildRuntimeStableTimeoutError(timeoutMs, lastHint, {
      path: lastSample && lastSample.path ? lastSample.path : '',
      elapsedMs: Date.now() - startedAt,
    })
  }

  const viewProbe = options.skipViewProbe
    ? { viewReady: false, viewNodeCount: 0 }
    : await probeRuntimeViewReady(lastSample.page)

  return {
    ok: true,
    condition: 'stable',
    path: lastSample.path,
    elapsedMs: Date.now() - startedAt,
    stableMs: Date.now() - stableSince,
    pageStackDepth: lastSample.pageStackDepth,
    viewReady: viewProbe.viewReady,
    viewNodeCount: viewProbe.viewNodeCount,
    viewError: viewProbe.viewError || undefined,
  }
}

// ---- native 诊断 ----

/**
 * 为 callNativeMethod 的返回值构建诊断消息。
 * 根据具体方法提供可操作 hint。
 */
function buildNativeDiagnostic(method, result, context: AnyRecord = {}) {
  const errorMessage = result && result.error && result.error.message
  const routeNotices = (context.routeEvents || []).map(formatRouteTimelineLine)
  const diagnostic: AnyRecord = {
    result,
    path: context.pathAfter || context.pathBefore || '',
    notices: routeNotices,
  }

  if (errorMessage) {
    let hint = '请检查当前宿主 UI 场景是否满足该 native 动作。'
    if (method === 'navigateLeft') {
      hint = '当前页面可能没有可用的原生返回栈；先确认是通过真实 navigateTo 进入，或改用 relaunch/goto。'
    } else if (method === 'switchTab') {
      hint = '当前项目可能没有原生 tabBar，或目标页面不是原生 tab 页；优先改用 click/ref 或 relaunch。'
    } else if (method === 'goHome') {
      hint = 'DevTools 当前宿主环境可能不支持 goHome，或当前并非可回首页场景；可改用 relaunch 到首页。'
    } else if (method === 'confirmModal' || method === 'cancelModal') {
      hint = '当前可能没有系统 modal；先触发对应动作，再调用该 native 命令。'
    }

    diagnostic.message = `${method} failed`
    diagnostic.error = errorMessage
    diagnostic.hint = hint
    return diagnostic
  }

  if ((method === 'confirmModal' || method === 'cancelModal')
    && context.pathBefore === context.pathAfter
    && routeNotices.length === 0) {
    diagnostic.message = `${method} 未观察到明显变化`
    diagnostic.hint = '当前可能没有系统 modal，或该 modal 对当前路由没有可见影响；可结合 timeline/logs 再确认。'
    return diagnostic
  }

  diagnostic.message = `已执行 native ${method}`
  if (context.pathAfter && context.pathBefore && context.pathAfter !== context.pathBefore) {
    diagnostic.path = context.pathAfter
  }
  return diagnostic
}

// make sleep accessible
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

module.exports = {
  normalizeAwaitCondition,
  resolveAwaitTimeoutMs,
  buildAwaitTimeoutError,
  buildRuntimeStableTimeoutError,
  extractLogSummary,
  selectLogSummaryLine,
  truncateLogSummaryLine,
  scoreLogSummaryLine,
  waitForMiniProgramCondition,
  waitForMiniProgramStable,
  countVisibleElements,
  readStableRuntimeSample,
  buildNativeDiagnostic,
  sleep,
}
