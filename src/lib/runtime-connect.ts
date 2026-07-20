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

// ---- 外部依赖类型 —— 仅声明本文件用到的方法 ----

/** MiniProgram 运行态句柄（来自 miniprogram-automator） */
interface MiniProgramRef {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>
  close(): Promise<void>
  disconnect(): Promise<void>
  on(event: string, cb: (payload: unknown) => void): void
  off(event: string, cb: (payload: unknown) => void): void
  removeListener(event: string, cb: (payload: unknown) => void): void
  screenshot(opts: { path: string }): Promise<void>
  currentPage(...args: unknown[]): Promise<unknown>
  pageStack?(...args: unknown[]): Promise<unknown[]>
  systemInfo?(): Promise<unknown>
  callWxMethod?(method: string, ...args: unknown[]): Promise<unknown>
  evaluate?(source: string): Promise<unknown>
  native?(): Record<string, unknown> | null
  __mpbRuntimeReady?: boolean
  __mpbRuntimeProbe?: unknown
  launcher?: { connectTool: (opts: { wsEndpoint: string }) => Promise<MiniProgramRef> }
}

/** automator 模块句柄（miniprogram-automator 顶层导出） */
interface AutomatorRef {
  connect(opts: { wsEndpoint: string }): Promise<MiniProgramRef>
  launcher?: { connectTool: (opts: { wsEndpoint: string }) => Promise<MiniProgramRef> }
}

/** 连接函数签名 */
type ConnectFn = (config: Record<string, unknown>, options?: Record<string, unknown>) => Promise<MiniProgramRef>
/** enableAutomation 函数签名 */
type EnableFn = (config: Record<string, unknown>, options?: Record<string, unknown>) => Record<string, unknown>

type ErrorWithMeta = Error & { raw?: string; runtimeNotReady?: boolean; runtimeProbe?: unknown; cause?: unknown }

// ---- 连接常量 ----

const WS_CONNECT_ATTEMPTS = 3
const WS_CONNECT_TIMEOUT_MS = 10000
const WS_RETRY_GAP_MS = 2000
const RUNTIME_PROBE_ATTEMPTS = 8
const RUNTIME_PROBE_TIMEOUT_MS = 15000
const RUNTIME_PROBE_GAP_MS = 3000
const DEFAULT_CONNECT_TIMEOUT_MS = 120000
const ENABLE_AUTO_WAIT_MS = 3000
const LIVE_POLL_MS = 500

/**
 * enable 之后：在 deadline 内轮询 automation 端口是否 live。
 * 最小等待 minWaitMs（默认 ENABLE_AUTO_WAIT），避免 CLI 刚返回就狂连。
 */
async function waitUntilAutomationLive(
  config: Record<string, unknown>,
  options: Record<string, unknown> = {},
): Promise<boolean> {
  const liveCheck = (options.isLive as ((cfg: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<boolean>) | undefined)
    || isAutomationEndpointLive
  const sleepFn = (options.sleepFn as ((ms: number) => Promise<void>) | undefined) || sleep
  const deadlineAt = Number(options.deadlineAt || 0)
  const minWaitMs = Math.max(0, Number(options.minWaitMs ?? ENABLE_AUTO_WAIT_MS))
  const pollMs = Math.max(100, Number(options.pollMs || LIVE_POLL_MS))
  const startedAt = Date.now()
  let iterations = 0
  const maxIterations = Math.max(3, Number(options.maxIterations || 40))

  if (minWaitMs > 0) {
    const remainingForMin = deadlineAt ? Math.max(0, Math.min(minWaitMs, deadlineAt - Date.now())) : minWaitMs
    if (remainingForMin > 0) {
      await sleepFn(remainingForMin)
    }
  }

  while (true) {
    iterations += 1
    if (deadlineAt && Date.now() >= deadlineAt) {
      return false
    }
    if (iterations > maxIterations) {
      return false
    }
    const live = await liveCheck(config, {
      timeoutMs: Math.min(1500, Math.max(300, deadlineAt ? deadlineAt - Date.now() : 1500)),
      automator: options.automator,
    }).catch(() => false)
    if (live) {
      return true
    }
    if (deadlineAt && Date.now() + pollMs >= deadlineAt) {
      const last = await liveCheck(config, {
        timeoutMs: Math.max(200, deadlineAt - Date.now()),
        automator: options.automator,
      }).catch(() => false)
      return Boolean(last)
    }
    await sleepFn(pollMs)
    if (!deadlineAt && Date.now() - startedAt > 60000) {
      return false
    }
  }
}


// ---- 通用超时辅助 ----

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

async function withProtocolTimeout<T>(promise: Promise<T>, label: string, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
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

async function captureScreenshotToPath(miniProgram: { screenshot: (opts: { path: string }) => Promise<void> }, targetPath: string, timeoutMs = 15000): Promise<string> {
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
  } catch (error: unknown) {
    if (error && /screenshot timeout/i.test(String((error as Error).message || ''))) {
      const nextError = new Error('screenshot timeout; 当前真实截图通道暂时不可用。优先改用 `miniprogram-browser screenshot --mode layout ...` 或 `snapshot -i --layout` 查看页面结构；只有在不同 session / 项目都持续超时时，再把完全重启 DevTools 当成最后手段。')
      nextError.cause = error
      throw nextError
    }
    throw error
  }

  return targetPath
}

// ---- miniProgram 清理 ----

async function cleanupMiniProgram(miniProgram: MiniProgramRef | null | undefined): Promise<void> {
  if (!miniProgram) {
    return
  }

  if (typeof miniProgram.disconnect === 'function') {
    try {
      await Promise.resolve(miniProgram.disconnect())
    } catch (_: unknown) {
    }
    return
  }

  if (typeof miniProgram.close === 'function') {
    try {
      await Promise.resolve(miniProgram.close())
    } catch (_: unknown) {
    }
  }
}

async function shutdownMiniProgram(miniProgram: MiniProgramRef | null | undefined): Promise<void> {
  if (!miniProgram) {
    return
  }

  if (typeof miniProgram.close === 'function') {
    try {
      await Promise.resolve(miniProgram.close())
    } catch (_: unknown) {
    }
    return
  }

  await cleanupMiniProgram(miniProgram)
}

// ---- 自动化工具 ----

function requireAutomator(config: Record<string, unknown>): Record<string, unknown> {
  return require('miniprogram-automator')
}

function automationWsEndpoint(config: Record<string, unknown>): string {
  return `ws://127.0.0.1:${config.autoPort}`
}

// ---- WebSocket 连接 ----

async function connectAutomationTool(automator: AutomatorRef, config: Record<string, unknown>): Promise<MiniProgramRef> {
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
async function connectWithRetry(config: Record<string, unknown>, options: Record<string, unknown> = {}): Promise<MiniProgramRef> {
  const automator = options.automator || require('miniprogram-automator')
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
    } catch (error: unknown) {
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
async function isAutomationEndpointLive(config: Record<string, unknown>, options: Record<string, unknown> = {}): Promise<boolean> {
  const automator = options.automator || require('miniprogram-automator')
  let miniProgram: MiniProgramRef | null = null
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

async function isTcpPortOpen(port: number, host = '127.0.0.1', timeoutMs = 200): Promise<boolean> {
  const net = require('node:net') as typeof import('node:net')
  return await new Promise((resolve) => {
    const socket = net.connect({ host, port })
    const done = (ok: boolean) => {
      socket.removeAllListeners()
      try {
        socket.destroy()
      } catch (_) {}
      resolve(ok)
    }
    socket.setTimeout(Math.max(50, timeoutMs), () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

/**
 * 在端口范围内发现已 live 的 automation WebSocket。
 * DevTools `auto` 有时返回 ✔ 但指定 --auto-port 未监听，或迟到落到其它端口；
 * 策略：① 先探针 preferred；② TCP 打开的端口再探针；③ 仍无则有限盲扫（skipTcp 或 TCP 全空时）。
 */
async function discoverLiveAutomationPort(
  config: Record<string, unknown> = {},
  options: Record<string, unknown> = {},
): Promise<string> {
  const preferred = String(config.autoPort || options.preferredPort || '').trim()
  const start = Math.max(1, Number(options.rangeStart || 9515))
  const end = Math.max(start, Number(options.rangeEnd || 9615))
  const timeoutMs = Math.max(200, Number(options.timeoutMs || 600))
  const tcpTimeoutMs = Math.max(50, Number(options.tcpTimeoutMs || 150))
  const maxProbes = Math.max(1, Number(options.maxProbes || 40))
  const liveCheck = (options.isLive as ((cfg: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<boolean>) | undefined)
    || isAutomationEndpointLive
  const skipTcp = options.skipTcp === true

  const tried = new Set<string>()
  const probe = async (port: string): Promise<boolean> => {
    if (!port || tried.has(port)) {
      return false
    }
    tried.add(port)
    return await liveCheck({ ...config, autoPort: port }, { timeoutMs }).catch(() => false)
  }

  if (preferred && await probe(preferred)) {
    return preferred
  }

  const rangePorts: number[] = []
  for (let port = start; port <= end; port += 1) {
    rangePorts.push(port)
  }

  if (!skipTcp) {
    for (const port of rangePorts) {
      if (tried.size >= maxProbes) {
        break
      }
      // eslint-disable-next-line no-await-in-loop
      const open = await isTcpPortOpen(port, '127.0.0.1', tcpTimeoutMs)
      if (!open) {
        continue
      }
      const key = String(port)
      // eslint-disable-next-line no-await-in-loop
      if (await probe(key)) {
        return key
      }
    }
  }

  // TCP 全空或 skipTcp：有限顺序盲扫（测试与 DevTools 假成功时兜底）
  for (const port of rangePorts) {
    if (tried.size >= maxProbes) {
      break
    }
    const key = String(port)
    // eslint-disable-next-line no-await-in-loop
    if (await probe(key)) {
      return key
    }
  }
  return ''
}

// ---- 探针 ----

/** 截断探针返回值（深对象截断） */
function summarizeProbeResult(value: unknown): unknown {
  if (value === undefined) {
    return null
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => summarizeProbeResult(item))
  }
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {}
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
async function callAutomationProbe(miniProgram: MiniProgramRef, method: string, params: Record<string, unknown> = {}, timeoutMs = 5000): Promise<Record<string, unknown>> {
  try {
    const result = await withProtocolTimeout(miniProgram.send(method, params), method, timeoutMs)
    return {
      method,
      ok: true,
      result: summarizeProbeResult(result),
    }
  } catch (error: unknown) {
    const message = error && typeof error === 'object' && 'message' in error ? String((error as Error).message) : String(error)
    return {
      method,
      ok: false,
      timeout: /timeout/iu.test(message),
      error: message,
    }
  }
}

/** 构造运行时未就绪的诊断消息 */
function formatRuntimeNotReadyMessage(config: Record<string, unknown>, probe: Record<string, unknown>): string {
  const timedOut = (probe.probes as Record<string, unknown>[] || [])
    .filter((item: Record<string, unknown>) => item.timeout)
    .map((item: Record<string, unknown>) => item.method)
  const toolInfo = probe.toolInfo as Record<string, unknown> | undefined
  const toolVersion = toolInfo && (toolInfo.SDKVersion || toolInfo.version)
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
async function waitForRuntimeReady(miniProgram: MiniProgramRef, config: Record<string, unknown>, options: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
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
    } catch (_: unknown) {
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
async function probeAutomationRuntime(config: Record<string, unknown>, options: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const automator = options.automator || require('miniprogram-automator')
  const timeoutMs = Number(options.timeoutMs || options.wait || 5000)
  const screenshotTimeoutMs = Number(options.screenshotTimeoutMs || Math.max(timeoutMs, 10000))
  let miniProgram: MiniProgramRef | null = null
  const payload: Record<string, unknown> = {
    endpoint: automationWsEndpoint(config),
    connected: false,
    toolInfo: null,
    appReady: false,
    probes: [],
  }

  try {
    miniProgram = await connectAutomationTool(automator, config)
    payload.connected = true
  } catch (error: unknown) {
    payload.connectError = error && typeof error === 'object' && 'message' in error ? String((error as Error).message) : String(error)
    payload.diagnosis = 'automation WebSocket is not reachable; DevTools automation may not be enabled yet.'
    return payload
  }

  try {
    const toolProbe = await callAutomationProbe(miniProgram, 'Tool.getInfo', {}, timeoutMs)
    const probeList = payload.probes as Record<string, unknown>[]
    probeList.push(toolProbe)
    if (toolProbe.ok) {
      const toolInfoResult = toolProbe.result as Record<string, unknown> | undefined
      payload.toolInfo = toolInfoResult
      if (toolInfoResult && toolInfoResult.version && !toolInfoResult.SDKVersion) {
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

    probeList.push(...(await Promise.all(appProbes)) as Record<string, unknown>[])

    payload.appReady = (payload.probes as Record<string, unknown>[]).some((item: Record<string, unknown>) => item.method === 'App.getCurrentPage' && item.ok)
      || (payload.probes as Record<string, unknown>[]).some((item: Record<string, unknown>) => item.method === 'App.getPageStack' && item.ok)

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
async function probeReadyMiniProgram(miniProgram: MiniProgramRef, options: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
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
async function assertMiniProgramRuntimeReady(miniProgram: MiniProgramRef, config: Record<string, unknown>, options: Record<string, unknown> = {}): Promise<void> {
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
async function sendAutomationProtocol(config: Record<string, unknown>, method: string, params: Record<string, unknown> = {}, options: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const automator = options.automator || require('miniprogram-automator')
  const timeoutMs = Number(options.timeoutMs || options.timeout || 5000)
  let miniProgram: MiniProgramRef | null = null
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
 * 策略：
 * 1. 若已有 autoPort 且 endpoint live → 直接 connect（后续 snapshot/click/goto 路径）
 * 2. 否则在允许时 enable（devtools auto）→ 短暂等待 → connect（首次 open/doctor）
 * 3. allowEnable=false（默认）且非 live → 明确要求先 open，避免 snapshot 等命令无脑全量 auto
 *
 * 必须优先复用 live endpoint：重复跑 auto 会重启小程序，把页面打回首页，
 * 并可能拖垮已建立的 automation 会话。
 */
async function connectOrEnable(config: Record<string, unknown>, options: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}): Promise<MiniProgramRef> {
  const configConnector = (overrides.connect as ConnectFn | undefined) || connectWithRetry
  const enable = (overrides.enable as EnableFn | undefined) || (await Promise.resolve().then(() => require('./runtime-cli'))).enableAutomation
  const sleepFn = overrides.sleepFn || sleep
  const liveCheck = (overrides.isLive as ((cfg: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<boolean>) | undefined)
    || isAutomationEndpointLive
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null
  // 默认不允许 enable：业务命令应复用 live endpoint；open/connect 显式 allowEnable=true
  const allowEnable = options.allowEnable === true || options.forceEnable === true

  const overallDeadlineMs = Number(options.timeoutMs || options.connectTimeoutMs || DEFAULT_CONNECT_TIMEOUT_MS)
  const deadlineAt = Date.now() + overallDeadlineMs
  const hasAutoPort = Boolean(String(config.autoPort || '').trim())
  let metadata: Record<string, unknown> = {}

  // 1. live endpoint 直接 connect，避免重复 auto 重置运行态
  if (hasAutoPort && !options.forceEnable) {
    const live = await liveCheck(config, {
      timeoutMs: Math.min(1500, Math.max(300, deadlineAt - Date.now())),
      automator: options.automator,
    }).catch(() => false)
    if (live) {
      onProgress && onProgress('connect')
      const miniProgram = await configConnector(config, { deadlineAt })
      if (!miniProgram) {
        throw new Error('connect returned no miniProgram reference')
      }
      const runtimeResult = await waitForRuntimeReady(miniProgram, config, { deadlineAt })
      miniProgram.__mpbRuntimeReady = runtimeResult.appReady !== false
      miniProgram.__mpbRuntimeProbe = runtimeResult.probe || null
      return miniProgram
    }
  }

  if (!allowEnable) {
    const portHint = hasAutoPort ? `（记录的 autoPort=${config.autoPort} 当前不可用）` : ''
    const projectHint = String(config.projectPath || '').trim()
      ? ` --project ${config.projectPath}`
      : ''
    throw new Error(
      `自动化未连接${portHint}。请先执行 open${projectHint} 建立 DevTools 自动化会话，再重试当前命令。`,
    )
  }

  // 2. enable: devtools auto
  onProgress && onProgress('enable')
  metadata = (enable(config, { openFirst: false }) || {}) as Record<string, unknown>
  if (!String(config.devtoolsPort || '').trim() && metadata.resolvedDevtoolsPort) {
    config.devtoolsPort = metadata.resolvedDevtoolsPort
  }

  // 3. 等到 automation 端口 live（最小等待 ENABLE_AUTO_WAIT，受 deadline 约束）
  onProgress && onProgress('wait-live')
  const preferredPort = String(config.autoPort || '').trim()
  let becameLive = await waitUntilAutomationLive(config, {
    deadlineAt,
    minWaitMs: Number.isFinite(Number(options.minWaitMs)) ? Number(options.minWaitMs) : ENABLE_AUTO_WAIT_MS,
    sleepFn,
    isLive: liveCheck,
    automator: options.automator,
  })
  if (!becameLive && preferredPort) {
    // 边界竞态：deadline 刚过 port 才 listen——再探一次
    becameLive = await liveCheck(config, {
      timeoutMs: 2000,
      automator: options.automator,
    }).catch(() => false)
  }
  // DevTools 有时 ✔ auto 但指定 port 未监听，实际挂在范围内其它 port（或迟到）
  if (!becameLive) {
    onProgress && onProgress('discover-port')
    const remainingMs = deadlineAt ? Math.max(0, deadlineAt - Date.now()) : 8000
    // 盲扫不依赖剩余 open deadline：auto 已返回后扫 port 是廉价自愈（TCP+短探针）
    const discovered = await discoverLiveAutomationPort(config, {
      preferredPort,
      timeoutMs: 400,
      tcpTimeoutMs: 120,
      // 覆盖 AUTO_PORT_RANGE 常见段；preferred 失败后至少扫到 preferred+40
      maxProbes: 50,
      isLive: liveCheck,
      automator: options.automator,
    }).catch(() => '')
    if (discovered) {
      config.autoPort = discovered
      metadata.discoveredAutoPort = discovered
      metadata.preferredAutoPort = preferredPort || undefined
      becameLive = true
    } else if (remainingMs < 0) {
      // keep becameLive false
    }
  }
  if (!becameLive && preferredPort) {
    throw new Error(
      [
        `冷启动未完成：automation 端口 autoPort=${preferredPort} 在超时前仍未就绪`,
        '（devtools auto 已返回，但 WebSocket 尚不可连——常见于 DevTools 仍在编译/拉起 cli server，或 automation 落在其它端口）。',
        '建议：1) 确认开发者工具已登录且项目窗可见；2) 加大 --timeout 后再次 open（不要立刻 --fresh）；',
        '3) 若 session list 已显示其它 live，直接 open 复用；4) 仍失败再看 devtools logs / 重启开发者工具。',
      ].join(''),
    )
  }

  // 4. connect WS
  onProgress && onProgress('connect')
  let miniProgram: MiniProgramRef | null = null
  try {
    miniProgram = await configConnector(config, { deadlineAt })
    if (!miniProgram) {
      throw new Error('connect returned no miniProgram reference')
    }
  } catch (error: unknown) {
    throw wrapConnectErrorWithStartupIssue(error, metadata.startupIssue as { message: string; raw?: string } | null)
  }

  // 5. wait for App runtime ready
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
async function withMiniProgram(state: Record<string, unknown>, task: (miniProgram: MiniProgramRef) => Promise<unknown>, options: Record<string, unknown> = {}): Promise<unknown> {
  const stateConfig = state.config as Record<string, unknown> | undefined
  if (!stateConfig || !String(stateConfig.projectPath || '').trim()) {
    throw new Error('Missing project path. 请在小程序项目目录执行，或传 --project <miniprogram-root> 后再 open/session 绑定。')
  }
  await mkdir((stateConfig.screenshotDir as string) || '', { recursive: true })
  await mkdir((stateConfig.tempScreenshotDir as string) || '', { recursive: true })
  const connect = (options.connectOrEnable as ConnectFn | undefined) || connectOrEnable
  const miniProgram = await connect(stateConfig, {
    connectTimeoutMs: options.connectTimeoutMs || options.timeoutMs || options.timeout,
    allowRuntimeNotReady: Boolean(options.allowRuntimeNotReady),
    // 默认 false：snapshot/click 等不得无脑 enable；open/connect 传 true
    allowEnable: options.allowEnable === true || options.forceEnable === true,
    forceEnable: Boolean(options.forceEnable),
    onProgress: options.onProgress,
  })
  const runtimeReady = miniProgram.__mpbRuntimeReady !== false
  const runtimeEvents: {
    consoleEvents: ReturnType<typeof normalizeConsoleEvent>[]
    exceptionEvents: ReturnType<typeof normalizeExceptionEvent>[]
  } = {
    consoleEvents: [],
    exceptionEvents: [],
  }
  const onConsole = (payload: unknown): void => {
    runtimeEvents.consoleEvents.push(normalizeConsoleEvent(payload))
  }
  const onException = (payload: unknown): void => {
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
async function confirmRouteAfterAction(miniProgram: MiniProgramRef, state: Record<string, unknown>, options: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const pathBefore = String(options.pathBefore || '').trim()
  const expectedPath = normalizeRuntimeRoute(options.expectedPath)
  const timeoutMs = Number(options.timeoutMs || 1500)
  const pollMs = Number(options.pollMs || 100)
  const startedAt = Date.now()
  let routeEvents: Record<string, unknown>[] = []
  let currentPath = pathBefore
  let expectedMatched = !expectedPath
  let expectedMatchCount = 0
  const expectedStableMatches = Math.max(1, Number(options.expectedStableMatches || 1))

  while (Date.now() - startedAt <= timeoutMs) {
    const timelineResult = await syncRouteTimelineEvents(miniProgram, state)
    routeEvents = timelineResult.events
    const currentPage = await getCurrentPage(miniProgram).catch(() => ({ path: pathBefore } as Record<string, string>))
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
  discoverLiveAutomationPort,
  summarizeProbeResult,
  callAutomationProbe,
  formatRuntimeNotReadyMessage,
  probeAutomationRuntime,
  assertMiniProgramRuntimeReady,
  probeReadyMiniProgram,
  waitForRuntimeReady,
  sendAutomationProtocol,
  connectOrEnable,
  waitUntilAutomationLive,
  withMiniProgram,
  confirmRouteAfterAction,
}
