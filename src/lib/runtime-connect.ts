/**
 * runtime-connect.ts — 连接/生命周期函数
 *
 * 本模块包含 miniprogram-browser 的核心连接和生命周期管理：
 * - 与 DevTools automation WebSocket 的连接/重试
 * - 运行时准备性探测
 * - miniProgram 清理和生命周期管理
 * - connectOrEnable 策略（优先 enable 或优先 connect）
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

function buildConnectRetryOptions(options: AnyRecord = {}) {
  const timeoutMs = Number(options.connectTimeoutMs || options.timeoutMs || options.timeout || 0)
  if (!(timeoutMs > 0)) {
    return options.allowRuntimeNotReady ? { allowRuntimeNotReady: true } : {}
  }

  const attempts = Math.max(1, Math.ceil(timeoutMs / 1000))
  const result: AnyRecord = {
    timeoutMs,
    maxAttempts: attempts,
    runtimeNotReadyMaxAttempts: Math.max(2, attempts),
    connectAttemptTimeoutMs: Math.max(250, Math.min(5000, Math.ceil(timeoutMs / attempts))),
  }
  if (options.allowRuntimeNotReady) {
    result.allowRuntimeNotReady = true
  }
  return result
}

/**
 * 带重试的自动化连接。
 *
 * 策略：
 * 1. 最多尝试 maxAttempts 次
 * 2. 每次连接后检查 App runtime ready
 * 3. runtimeNotReady 超限后 break
 * 4. 支持 deadline 超时（timeoutMs）
 */
async function connectWithRetry(config, options: AnyRecord = {}) {
  const automator = options.automator || requireAutomator(config)
  const maxAttempts = Number(options.maxAttempts || 10)
  const runtimeNotReadyMaxAttempts = Number(options.runtimeNotReadyMaxAttempts || 2)
  const sleepFn = options.sleepFn || sleep
  const timeoutMs = Number(options.timeoutMs || 0)
  const deadlineAt = timeoutMs > 0 ? Date.now() + timeoutMs : 0
  const defaultAttemptTimeoutMs = Math.max(100, Number(options.connectAttemptTimeoutMs || 5000))
  let lastError
  let runtimeNotReadyAttempts = 0

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (deadlineAt && Date.now() >= deadlineAt) {
      break
    }

    let miniProgram = null
    try {
      const remainingMs = deadlineAt ? Math.max(1, deadlineAt - Date.now()) : defaultAttemptTimeoutMs
      miniProgram = await withProtocolTimeout(
        connectAutomationTool(automator, config),
        'connectTool',
        Math.min(defaultAttemptTimeoutMs, remainingMs),
      )
      await assertMiniProgramRuntimeReady(miniProgram, config, options)
      miniProgram.__mpbRuntimeReady = true
      delete miniProgram.__mpbRuntimeProbe
      return miniProgram
    } catch (error) {
      lastError = error
      if (error && error.runtimeNotReady && options.allowRuntimeNotReady && miniProgram) {
        miniProgram.__mpbRuntimeReady = false
        miniProgram.__mpbRuntimeProbe = error.runtimeProbe || null
        return miniProgram
      }
      if (miniProgram) {
        await cleanupMiniProgram(miniProgram)
      }

      if (error && error.runtimeNotReady) {
        runtimeNotReadyAttempts += 1
        if (runtimeNotReadyAttempts >= runtimeNotReadyMaxAttempts) {
          break
        }
      }

      if (deadlineAt && Date.now() >= deadlineAt) {
        break
      }

      const delayMs = deadlineAt ? Math.min(1000, Math.max(0, deadlineAt - Date.now())) : 1000
      if (delayMs > 0) {
        await sleepFn(delayMs)
      }
    }
  }

  if (deadlineAt && Date.now() >= deadlineAt) {
    const error = new Error(`automation connect timed out after ${timeoutMs}ms`) as ErrorWithMeta
    error.code = 'AUTOMATION_CONNECT_TIMEOUT'
    error.cause = lastError
    throw error
  }

  throw lastError
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

/** 总结探针返回值（深对象截断） */
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

// ---- 连接策略 ----

/**
 * 连接或启用自动化。
 *
 * 策略模式：
 * - preferEnable：先 enable（启动 DevTools auto）再 connect
 * - 默认先 connect，失败且有 allowEnableFallback 时 fallback 到 enable
 */
async function connectOrEnable(config, options: AnyRecord = {}, overrides: AnyRecord = {}) {
  const connect = overrides.connect || connectWithRetry
  const enable = overrides.enable || (await Promise.resolve().then(() => require('./runtime-cli'))).enableAutomation
  const sleepFn = overrides.sleepFn || sleep
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null
  const connectOptions = buildConnectRetryOptions(options)
  const enableDelayMs = Number(options.connectTimeoutMs || options.timeoutMs || options.timeout || 0) > 0
    ? Math.max(50, Math.min(5000, Math.floor(Number(options.connectTimeoutMs || options.timeoutMs || options.timeout) / 4)))
    : 5000

  if (options.preferEnable) {
    onProgress && onProgress('enable')
    const metadata = enable(config) || {}
    if (!String(config.devtoolsPort || '').trim() && metadata.resolvedDevtoolsPort) {
      config.devtoolsPort = metadata.resolvedDevtoolsPort
    }
    await sleepFn(enableDelayMs)
    onProgress && onProgress('connect')
    try {
      return await connect(config, connectOptions)
    } catch (error) {
      throw wrapConnectErrorWithStartupIssue(error, metadata.startupIssue)
    }
  }

  try {
    onProgress && onProgress('connect')
    return await connect(config, connectOptions)
  } catch (connectError) {
    if (!options.allowEnableFallback) {
      throw connectError
    }

    onProgress && onProgress('enable')
    const metadata = enable(config) || {}
    if (!String(config.devtoolsPort || '').trim() && metadata.resolvedDevtoolsPort) {
      config.devtoolsPort = metadata.resolvedDevtoolsPort
    }
    await sleepFn(enableDelayMs)
    onProgress && onProgress('connect')
    try {
      return await connect(config, connectOptions)
    } catch (error) {
      throw wrapConnectErrorWithStartupIssue(error, metadata.startupIssue)
    }
  }
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
    preferEnable: options.preferEnable !== undefined
      ? Boolean(options.preferEnable)
      : Boolean(state.portResolution && state.portResolution.autoPortAssigned),
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
  buildConnectRetryOptions,
  connectWithRetry,
  isAutomationEndpointLive,
  summarizeProbeResult,
  callAutomationProbe,
  formatRuntimeNotReadyMessage,
  probeAutomationRuntime,
  assertMiniProgramRuntimeReady,
  probeReadyMiniProgram,
  sendAutomationProtocol,
  connectOrEnable,
  withMiniProgram,
  confirmRouteAfterAction,
}
