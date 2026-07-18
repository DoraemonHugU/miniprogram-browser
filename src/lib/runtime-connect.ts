/**
 * runtime-connect.ts — 连接/生命周期函数
 *
 * 本模块包含 miniprogram-browser 的核心连接和生命周期管理：
 * - 与 DevTools automation WebSocket 的连接/重试
 * - 运行时准备性探测
 * - miniProgram 清理和生命周期管理
 * - open：一次 enable + connect，无复杂策略
 * - 自动化协议发送
 */

const { normalizeConsoleEvent, normalizeExceptionEvent, normalizeRuntimeRoute, appendRuntimeEvents } = require('./runtime-core')
const { syncCurrentRoute } = require('./runtime-state')
const { ensureRouteTimelineMonitor, syncRouteTimelineEvents } = require('./runtime-timeline')
const { getCurrentPage } = require('./runtime-bridge')
const { sleep } = require('./runtime-wait')
const { wrapConnectErrorWithStartupIssue } = require('./runtime-cli-shared')
const { mkdir } = require('node:fs/promises')

type AnyRecord = Record<string, any>
type ErrorWithMeta = Error & AnyRecord

// ---- 连接常量 ----

const WS_CONNECT_ATTEMPTS = 3
const WS_CONNECT_TIMEOUT_MS = 10000
const WS_RETRY_GAP_MS = 2000
const RUNTIME_PROBE_ATTEMPTS = 8
const RUNTIME_PROBE_TIMEOUT_MS = 15000
const RUNTIME_PROBE_GAP_MS = 3000
const DEFAULT_CONNECT_TIMEOUT_MS = 120000
const ENABLE_AUTO_WAIT_MS = 3000

// ---- 通用超时辅助 ----

async function withTimeout(promise, label, timeoutMs) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

async function withProtocolTimeout(promise, label, timeoutMs) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

// ---- 截图 ----

async function captureScreenshotToPath(miniProgram, targetPath, timeoutMs = 15000) {
  if (timeoutMs <= 0) {
    await miniProgram.screenshot({ path: targetPath })
    return targetPath
  }

  try {
    await withTimeout(
      miniProgram.screenshot({ path: targetPath }),
      'screenshot',
      timeoutMs,
    )
  } catch (error) {
    if (error && /screenshot timeout/i.test(String(error.message || ''))) {
      const nextError = new Error('screenshot timeout; 当前真实截图通道暂时不可用。优先改用 `miniprogram-browser screenshot --mode layout ...` 或 `snapshot -i --layout` 查看页面结构；只有在不同 session / 项目都持续超时时，再把完全重启 DevTools 当成最后手段。')
      nextError.cause = error
      throw nextError
    }
    throw error
  }

  return targetPath
}

// ---- miniProgram 清理 ----

async function cleanupMiniProgram(miniProgram) {
  if (!miniProgram) {
    return
  }

  if (typeof miniProgram.disconnect === 'function') {
    try {
      await Promise.resolve(miniProgram.disconnect())
    } catch (_) {
    }
    return
  }

  if (typeof miniProgram.close === 'function') {
    try {
      await Promise.resolve(miniProgram.close())
    } catch (_) {
    }
  }
}

async function shutdownMiniProgram(miniProgram) {
  if (!miniProgram) {
    return
  }

  if (typeof miniProgram.close === 'function') {
    try {
      await Promise.resolve(miniProgram.close())
    } catch (_) {
    }
    return
  }

  await cleanupMiniProgram(miniProgram)
}

// ---- 自动化工具 ----

function requireAutomator(config) {
  return require('miniprogram-automator')
}

function automationWsEndpoint(config) {
  return `ws://127.0.0.1:${config.autoPort}`
}

// ---- WebSocket 连接 ----

async function connectAutomationTool(automator, config) {
  const endpoint = automationWsEndpoint(config)
  if (automator && automator.launcher && typeof automator.launcher.connectTool === 'function') {
    return await automator.launcher.connectTool({ wsEndpoint: endpoint })
  }
  return await automator.connect({ wsEndpoint: endpoint })
}

/**
 * 连接 WebSocket（简化版）。
 *
 * 策略：
 * - 最多尝试 WS_CONNECT_ATTEMPTS（3）次
 * - 每次超时 WS_CONNECT_TIMEOUT_MS（10s）
 * - 间隔 WS_RETRY_GAP_MS（2s）
 * - 受 deadlineAt 外部约束
 */
async function connectWithRetry(config, options: AnyRecord = {}) {
  const automator = options.automator || requireAutomator(config)
  const deadlineAt = Number(options.deadlineAt || 0)
  const maxAttempts = Number(options.maxAttempts || WS_CONNECT_ATTEMPTS)
  const attemptTimeoutMs = Number(options.attemptTimeoutMs || WS_CONNECT_TIMEOUT_MS)
  const sleepFn = options.sleepFn || sleep

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (deadlineAt && Date.now() >= deadlineAt) {
      break
    }

    try {
      const remainingMs = deadlineAt ? Math.max(1000, deadlineAt - Date.now()) : attemptTimeoutMs
      return await withProtocolTimeout(
        connectAutomationTool(automator, config),
        'connectTool',
        Math.min(attemptTimeoutMs, remainingMs),
      )
    } catch (error) {
      if (attempt < maxAttempts) {
        const delayMs = deadlineAt
          ? Math.min(WS_RETRY_GAP_MS, Math.max(0, deadlineAt - Date.now()))
          : WS_RETRY_GAP_MS
        if (delayMs > 0) {
          await sleepFn(delayMs)
        }
      } else {
        throw error
      }
    }
  }

  throw new Error(`Automation WebSocket connection failed after ${maxAttempts} attempts`)
}

/** 检查 automation 端点是否存活（快速探针） */
async function isAutomationEndpointLive(config, options: AnyRecord = {}) {
  const automator = options.automator || requireAutomator(config)
  let miniProgram = null
  try {
    miniProgram = await connectAutomationTool(automator, config)
    await callAutomationProbe(miniProgram, 'Tool.getInfo', {}, Number(options.timeoutMs || 1000))
    return true
  } catch (_) {
    return false
  } finally {
    if (miniProgram) {
      await cleanupMiniProgram(miniProgram)
    }
  }
}

// ---- 探针 ----

/** 截断探针返回值（深对象截断） */
function summarizeProbeResult(value) {
  if (value === undefined) {
    return null
  }
  if (Array.isArray(value)) {
    return value.map((item) => summarizeProbeResult(item))
  }
  if (value && typeof value === 'object') {
    const output = {}
    for (const [key, item] of Object.entries(value)) {
      if (key === 'data' && typeof item === 'string' && item.length > 256) {
        output[key] = `${item.slice(0, 256)}...`
      } else {
        output[key] = summarizeProbeResult(item)
      }
    }
    return output
  }
  return value
}

/** 调用单个 automation 探针方法 */
async function callAutomationProbe(miniProgram, method, params: AnyRecord = {}, timeoutMs = 5000) {
  try {
    const result = await withProtocolTimeout(miniProgram.send(method, params), method, timeoutMs)
    return {
      method,
      ok: true,
      result: summarizeProbeResult(result),
    }
  } catch (error) {
    const message = error && error.message ? String(error.message) : String(error)
    return {
      method,
      ok: false,
      timeout: /timeout/iu.test(message),
      error: message,
    }
  }
}

/** 构造运行时未就绪的诊断消息 */
function formatRuntimeNotReadyMessage(config, probe) {
  const timedOut = (probe.probes || [])
    .filter((item) => item.timeout)
    .map((item) => item.method)
  const toolVersion = probe.toolInfo && (probe.toolInfo.SDKVersion || probe.toolInfo.version)
  const details = [
    `Automation WebSocket is reachable at ${automationWsEndpoint(config)}, but the MiniProgram App runtime did not become ready.`,
  ]
  if (toolVersion) {
    details.push(`DevTools version=${toolVersion}.`)
  }
  if (timedOut.length) {
    details.push(`Timed out methods: ${timedOut.join(', ')}.`)
  }
  return details.join(' ')
}

/**
 * 等待 App runtime 就绪。
 *
 * 轮询 App.getCurrentPage，超时 RUNTIME_PROBE_TIMEOUT_MS（15s），
 * 最多 RUNTIME_PROBE_ATTEMPTS（8）次 = 最长 ~120s。
 *
 * 成功 → 返回 miniProgram（标记 runtimeReady=true）
 * 超时 → 返回 miniProgram（标记 runtimeReady=false）
 */
async function waitForRuntimeReady(miniProgram, config, options: AnyRecord = {}) {
  const maxAttempts = Number(options.runtimeProbeAttempts || RUNTIME_PROBE_ATTEMPTS)
  const probeTimeoutMs = Number(options.runtimeProbeTimeoutMs || RUNTIME_PROBE_TIMEOUT_MS)
  const gapMs = Number(options.runtimeProbeGapMs || RUNTIME_PROBE_GAP_MS)
  const deadlineAt = Number(options.deadlineAt || 0)

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (deadlineAt && Date.now() >= deadlineAt) {
      break
    }

    try {
      const result = await withProtocolTimeout(
        miniProgram.send('App.getCurrentPage'),
        'App.getCurrentPage',
        probeTimeoutMs,
      )
      // App runtime 就绪
      miniProgram.__mpbRuntimeReady = true
      delete miniProgram.__mpbRuntimeProbe
      return { appReady: true }
    } catch (_) {
      // 继续等
    }

    const remainingMs = deadlineAt ? Math.max(0, deadlineAt - Date.now()) : gapMs
    if (remainingMs > 0) {
      await sleep(Math.min(gapMs, remainingMs))
    }
  }

  // 超时——App runtime 未就绪，但不抛异常
  miniProgram.__mpbRuntimeReady = false
  const probe = await probeReadyMiniProgram(miniProgram, { probeToolTimeoutMs: 1000, probeCurrentPageTimeoutMs: 1000 })
  miniProgram.__mpbRuntimeProbe = probe

  return { appReady: false, probe }
}

/**
 * 完整探测运行时准备状态。
 *
 * 包括 WebSocket 连接检查，Tool.getInfo，App.getCurrentPage，App.getPageStack，
 * App.callWxMethod（getSystemInfoSync）和可选的 App.captureScreenshot。
 */
async function probeAutomationRuntime(config, options: AnyRecord = {}) {
  const automator = options.automator || requireAutomator(config)
  const timeoutMs = Number(options.timeoutMs || options.wait || 5000)
  const screenshotTimeoutMs = Number(options.screenshotTimeoutMs || Math.max(timeoutMs, 10000))
  let miniProgram = null
  const payload: AnyRecord = {
    endpoint: automationWsEndpoint(config),
    connected: false,
    toolInfo: null,
    appReady: false,
    probes: [],
  }

  try {
    miniProgram = await connectAutomationTool(automator, config)
    payload.connected = true
  } catch (error) {
    payload.connectError = error && error.message ? String(error.message) : String(error)
    payload.diagnosis = 'automation WebSocket is not reachable; DevTools automation may not be enabled yet.'
    return payload
  }

  try {
    const toolProbe = await callAutomationProbe(miniProgram, 'Tool.getInfo', {}, timeoutMs)
    payload.probes.push(toolProbe)
    if (toolProbe.ok) {
      payload.toolInfo = toolProbe.result
      if (payload.toolInfo && payload.toolInfo.version && !payload.toolInfo.SDKVersion) {
        payload.toolInfoNotice = 'Tool.getInfo did not expose SDKVersion; this DevTools build is incompatible with miniprogram-automator checkVersion(), so miniprogram-browser uses layered readiness probes instead.'
      }
    }

    const appProbes = [
      callAutomationProbe(miniProgram, 'App.getCurrentPage', {}, timeoutMs),
      callAutomationProbe(miniProgram, 'App.getPageStack', {}, timeoutMs),
      callAutomationProbe(miniProgram, 'App.callWxMethod', {
        method: 'getSystemInfoSync',
        args: [],
      }, timeoutMs),
    ]

    if (options.screenshot) {
      appProbes.push(callAutomationProbe(miniProgram, 'App.captureScreenshot', {}, screenshotTimeoutMs))
    }

    payload.probes.push(...await Promise.all(appProbes))

    payload.appReady = payload.probes.some((item) => item.method === 'App.getCurrentPage' && item.ok)
      || payload.probes.some((item) => item.method === 'App.getPageStack' && item.ok)

    if (!payload.appReady) {
      payload.diagnosis = 'Tool layer is reachable, but App runtime probes did not respond. DevTools likely opened the project while compile/simulator/AppService is still failing or stuck.'
    } else {
      payload.diagnosis = 'Tool layer and App runtime are both responsive.'
    }
    return payload
  } finally {
    if (miniProgram) {
      await cleanupMiniProgram(miniProgram)
    }
  }
}

/** 快速运行时准备性探针（Tool.getInfo + App.getCurrentPage） */
async function probeReadyMiniProgram(miniProgram, options: AnyRecord = {}) {
  const probes = []
  const toolProbe = await callAutomationProbe(miniProgram, 'Tool.getInfo', {}, Number(options.probeToolTimeoutMs || 1500))
  probes.push(toolProbe)
  const currentPageProbe = await callAutomationProbe(miniProgram, 'App.getCurrentPage', {}, Number(options.probeCurrentPageTimeoutMs || 3000))
  probes.push(currentPageProbe)
  return {
    toolInfo: toolProbe.ok ? toolProbe.result : null,
    appReady: currentPageProbe.ok,
    probes,
  }
}

/** 断言 miniProgram 运行时已就绪 */
async function assertMiniProgramRuntimeReady(miniProgram, config, options: AnyRecord = {}) {
  const probe = await probeReadyMiniProgram(miniProgram, options)
  if (probe.appReady) {
    return
  }
  const error = new Error(formatRuntimeNotReadyMessage(config, probe)) as ErrorWithMeta
  error.raw = JSON.stringify(probe)
  error.runtimeNotReady = true
  error.runtimeProbe = probe
  throw error
}

// ---- 协议发送 ----

/** 发送自动化协议方法（已连接 -> 发送 -> 断开） */
async function sendAutomationProtocol(config, method, params: AnyRecord = {}, options: AnyRecord = {}) {
  const automator = options.automator || requireAutomator(config)
  const timeoutMs = Number(options.timeoutMs || options.timeout || 5000)
  let miniProgram = null
  try {
    miniProgram = await connectAutomationTool(automator, config)
    return {
      endpoint: automationWsEndpoint(config),
      ...(await callAutomationProbe(miniProgram, method, params, timeoutMs)),
    }
  } finally {
    if (miniProgram) {
      await cleanupMiniProgram(miniProgram)
    }
  }
}

// ---- 连接入口（单通道）----

/**
 * 连接或启用自动化。
 *
 * 策略：先 enable（devtools auto），等一会，再 connect。
 * 不再支持先 connect 后 fallback 的模式——在 WSL 场景下 WS 永远不可用直至 auto 运行。
 */
async function connectOrEnable(config, options: AnyRecord = {}, overrides: AnyRecord = {}) {
  const connect = overrides.connect || connectWithRetry
  const enable = overrides.enable || (await Promise.resolve().then(() => require('./runtime-cli'))).enableAutomation
  const sleepFn = overrides.sleepFn || sleep
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null

  const overallDeadlineMs = Number(options.timeoutMs || options.connectTimeoutMs || DEFAULT_CONNECT_TIMEOUT_MS)
  const deadlineAt = Date.now() + overallDeadlineMs

  // 1. enable: devtools auto
  onProgress && onProgress('enable')
  const metadata = enable(config, { openFirst: false }) || {}
  if (!String(config.devtoolsPort || '').trim() && metadata.resolvedDevtoolsPort) {
    config.devtoolsPort = metadata.resolvedDevtoolsPort
  }

  // 2. 等一会，让 DevTools IDE 有时间完成初始化
  await sleepFn(ENABLE_AUTO_WAIT_MS)

  // 3. connect WS
  onProgress && onProgress('connect')
  let miniProgram = null
  try {
    miniProgram = await connect(config, { deadlineAt })
    if (!miniProgram) {
      throw new Error('connect returned no miniProgram reference')
    }
  } catch (error) {
    throw wrapConnectErrorWithStartupIssue(error, metadata.startupIssue)
  }

  // 4. wait for App runtime ready
  const runtimeResult = await waitForRuntimeReady(miniProgram, config, { deadlineAt })
  if (!runtimeResult.appReady) {
    miniProgram.__mpbRuntimeReady = false
    miniProgram.__mpbRuntimeProbe = runtimeResult.probe || null
  } else {
    miniProgram.__mpbRuntimeReady = true
  }

  return miniProgram
}

// ---- 高阶封装 ----

/**
 * withMiniProgram：在 miniProgram 上下文内执行 task。
 *
 * 管理连接、事件监听、清理和状态同步。
 * - 建立连接（通过 connectOrEnable）
 * - 注册 console/exception 事件监听
 * - 执行 task
 * - finally：清理事件监听、同步路由、断开连接
 */
async function withMiniProgram(state, task, options: AnyRecord = {}) {
  if (!state.config || !String(state.config.projectPath || '').trim()) {
    throw new Error('Missing project path. Pass --project <miniprogram-root> on first open/session binding.')
  }
  await mkdir(state.config.screenshotDir, { recursive: true })
  await mkdir(state.config.tempScreenshotDir, { recursive: true })
  const connect = options.connectOrEnable || connectOrEnable
  const miniProgram = await connect(state.config, {
    connectTimeoutMs: options.connectTimeoutMs || options.timeoutMs || options.timeout,
    allowRuntimeNotReady: Boolean(options.allowRuntimeNotReady),
    onProgress: options.onProgress,
  })
  const runtimeReady = miniProgram.__mpbRuntimeReady !== false
  const runtimeEvents = {
    consoleEvents: [],
    exceptionEvents: [],
  }
  const onConsole = (payload) => {
    runtimeEvents.consoleEvents.push(normalizeConsoleEvent(payload))
  }
  const onException = (payload) => {
    runtimeEvents.exceptionEvents.push(normalizeExceptionEvent(payload))
  }

  if (typeof miniProgram.on === 'function') {
    miniProgram.on('console', onConsole)
    miniProgram.on('exception', onException)
  }

  try {
    if (runtimeReady) {
      await ensureRouteTimelineMonitor(miniProgram)
    }
    return await task(miniProgram)
  } finally {
    if (typeof miniProgram.off === 'function') {
      miniProgram.off('console', onConsole)
      miniProgram.off('exception', onException)
    } else if (typeof miniProgram.removeListener === 'function') {
      miniProgram.removeListener('console', onConsole)
      miniProgram.removeListener('exception', onException)
    }
    appendRuntimeEvents(state, runtimeEvents)
    if (runtimeReady) {
      await syncCurrentRoute(state, miniProgram)
    }
    await cleanupMiniProgram(miniProgram)
  }
}

/**
 * 确认动作后路由已到达预期位置。
 *
 * 轮询路由时间线和 currentPage，等待：
 * - 路由事件出现
 * - 或指定 expectedPath 稳定匹配
 */
async function confirmRouteAfterAction(miniProgram, state, options: AnyRecord = {}) {
  const pathBefore = String(options.pathBefore || '').trim()
  const expectedPath = normalizeRuntimeRoute(options.expectedPath)
  const timeoutMs = Number(options.timeoutMs || 1500)
  const pollMs = Number(options.pollMs || 100)
  const startedAt = Date.now()
  let routeEvents = []
  let currentPath = pathBefore
  let expectedMatched = !expectedPath
  let expectedMatchCount = 0
  const expectedStableMatches = Math.max(1, Number(options.expectedStableMatches || 1))

  while (Date.now() - startedAt <= timeoutMs) {
    const timelineResult = await syncRouteTimelineEvents(miniProgram, state)
    routeEvents = timelineResult.events
    const currentPage = await getCurrentPage(miniProgram).catch(() => ({ path: pathBefore }))
    currentPath = currentPage && currentPage.path ? String(currentPage.path) : pathBefore
    expectedMatched = expectedPath ? normalizeRuntimeRoute(currentPath) === expectedPath : true
    expectedMatchCount = expectedMatched ? expectedMatchCount + 1 : 0

    if (!expectedPath && routeEvents.length > 0 && currentPath === pathBefore) {
      const latestRoute = routeEvents[routeEvents.length - 1]
      if (latestRoute && latestRoute.to) {
        currentPath = String(latestRoute.to)
      }
    }
    state.route = currentPath

    if (expectedPath && expectedMatchCount >= expectedStableMatches) {
      break
    }

    if (!expectedPath && (routeEvents.length > 0 || (pathBefore && currentPath && pathBefore !== currentPath))) {
      break
    }

    await sleep(pollMs)
  }

  return {
    path: currentPath,
    routeEvents,
    expectedPath: expectedPath || undefined,
    expectedMatched: expectedPath ? expectedMatchCount >= expectedStableMatches : expectedMatched,
  }
}

module.exports = {
  withTimeout,
  withProtocolTimeout,
  captureScreenshotToPath,
  cleanupMiniProgram,
  shutdownMiniProgram,
  requireAutomator,
  automationWsEndpoint,
  connectAutomationTool,
  connectWithRetry,
  isAutomationEndpointLive,
  summarizeProbeResult,
  callAutomationProbe,
  formatRuntimeNotReadyMessage,
  probeAutomationRuntime,
  assertMiniProgramRuntimeReady,
  probeReadyMiniProgram,
  waitForRuntimeReady,
  sendAutomationProtocol,
  connectOrEnable,
  withMiniProgram,
  confirmRouteAfterAction,
}
