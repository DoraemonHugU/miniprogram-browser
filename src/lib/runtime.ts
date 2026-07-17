const { accessSync, constants, existsSync, statSync } = require('node:fs')
const { mkdir, readFile, readdir, stat } = require('node:fs/promises')
const { createHash } = require('node:crypto')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

type AnyRecord = Record<string, any>
type ErrorWithMeta = Error & AnyRecord

const {
  buildTreeSnapshotRecords,
  createRefRecordFromNode,
  formatSnapshotLines,
} = require('./core')

const { resolveEnvironment } = require('./platform')

const {
  toWindowsPath,
  isWslUncPath,
  normalizeWindowsPathForCompare,
  runWindowsCommand,
  windowsPathExists,
  isWindowsDirectoryEmpty,
  readWindowsPathAttributes,
  isWindowsDirectoryLinkPath,
  resolveWindowsTempDirectory,
  isRobocopySuccess,
  createWindowsProjectMirrorFromWslUnc,
  resolveWindowsManagedProjectPath,
  cleanupWindowsProjectAutoLink,
  cleanupWindowsProjectMirror,
  isWindowsProjectMirrorDrained,
  readWindowsTextFile,
  findManagedWindowsProjectMirrors,
  isManagedWindowsProjectPath,
  isManagedWindowsProjectLinkPath,
} = require('./runtime-windows')
const {
  resolveDevtoolsProjectPath,
  buildAutomationArgs,
  buildDevtoolsOpenArgs,
  validateAutomationCliConfig,
  runDevtoolsCli,
  runAutomationCli,
  openDevtoolsProject,
  resolveDevtoolsProjectPathForClose,
  closeDevtoolsProject,
  enableAutomation,
  resolveMappedDevtoolsProjectPath,
  assertSupportedDevtoolsProjectPath,
} = require('./runtime-cli')
const {
  resolveDevtoolsLogRoot,
  discoverActiveDevtoolsLogRoot,
  listDevtoolsLogFiles,
  tailLogLines,
  collectDevtoolsLogs,
  resolveWindowsLocalAppData,
  windowsPathToWslPath,
} = require('./runtime-logs')

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

const CONTENT_RUNTIME_TAGS = new Set([
  'text',
  'label',
])

const STRUCTURAL_RUNTIME_TAGS = new Set([
  'scroll-view',
  'swiper',
  'swiper-item',
])

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

function toSerializable(value, seen = new WeakSet()) {
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
    const result = {}
    for (const [key, item] of Object.entries(value)) {
      result[key] = toSerializable(item, seen)
    }
    seen.delete(value)
    return result
  }

  return String(value)
}

function normalizeConsoleEvent(payload) {
  const normalized = toSerializable(payload)
  return {
    ts: Date.now(),
    type: normalized && normalized.type ? String(normalized.type) : 'log',
    args: Array.isArray(normalized && normalized.args) ? normalized.args : [],
    raw: normalized,
  }
}

function normalizeExceptionEvent(payload) {
  const normalized = toSerializable(payload)
  return {
    ts: Date.now(),
    message: normalized && normalized.message ? String(normalized.message) : '',
    stack: normalized && normalized.stack ? String(normalized.stack) : '',
    raw: normalized,
  }
}

function normalizeRouteTimelineEvent(payload) {
  const normalized = toSerializable(payload) || {}
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

function normalizeRuntimeRoute(value) {
  return String(value || '').trim().replace(/^\//u, '').replace(/\?.*$/u, '')
}

function appendRuntimeEvents(state, events) {
  state.consoleEvents = [
    ...(Array.isArray(state.consoleEvents) ? state.consoleEvents : []),
    ...(events.consoleEvents || []),
  ]
  state.exceptionEvents = [
    ...(Array.isArray(state.exceptionEvents) ? state.exceptionEvents : []),
    ...(events.exceptionEvents || []),
  ]
}

function formatRuntimeEventLines(events, formatter) {
  return (events || []).map(formatter)
}

function formatConsoleEventLine(event) {
  const args = Array.isArray(event && event.args) ? event.args : []
  const text = args.map((item) => {
    if (typeof item === 'string') {
      return item
    }
    return JSON.stringify(item)
  }).join(' ')
  return `${event.type || 'log'} ${text}`.trim()
}

function formatExceptionEventLine(event) {
  const message = String((event && event.message) || '').trim()
  if (message) {
    return message
  }

  return JSON.stringify((event && event.raw) || {})
}

function formatRouteTimelineLine(event) {
  return String((event && event.message) || '').trim()
}

function normalizeRuntimeIdentityText(value) {
  return String(value || '').replace(/\s+/gu, ' ').trim().slice(0, 80)
}

function resolveRuntimeStableText(node) {
  return normalizeRuntimeIdentityText(node && typeof node === 'object' ? (node.identityText || node.text) : '')
}

function buildClickNotices({ pathBefore, pathAfter, routeEvents = [] }) {
  if ((routeEvents || []).length > 0) {
    return routeEvents.map(formatRouteTimelineLine)
  }

  if (pathBefore && pathAfter && pathBefore === pathAfter) {
    return ['点击后页面未跳转；如果预期应跳页，请检查是否出现登录/授权弹窗，可尝试 native confirmModal 或查看 timeline/logs。']
  }

  return []
}

function formatAutomationCliError(rawMessage) {
  const message = String(rawMessage || '').trim()
  const restartMatch = message.match(/IDE server has started on http:\/\/127\.0\.0\.1:(\d+) and must be restarted on port (\d+) first/u)
  if (restartMatch) {
    const [, currentPort, targetPort] = restartMatch
    return {
      message: `需要先把当前 DevTools HTTP 服务从 ${currentPort} 重启到 ${targetPort}，然后再绑定这个新 session；可先 close 当前 session 或在微信开发者工具里重启服务端口。`,
      raw: message,
    }
  }

  const initializeMatch = message.match(/IDE may already started at port\s+(\d+),\s*trying to connect/iu)
  if (initializeMatch && /wait IDE port timeout/iu.test(message)) {
    const [, port] = initializeMatch
    return {
      message: `检测到已有 DevTools IDE 实例正在使用端口 ${port}，但这次 attach 连接超时；通常说明该 DevTools 实例当前不健康、仍在初始化，或已经卡住。请先完全关闭微信开发者工具后重试 open；如果确认该 IDE 仍可用，也可稍后重试 open。`,
      raw: message,
    }
  }

  const startupIssue = detectAutomationStartupIssue(message)
  if (startupIssue) {
    return startupIssue
  }

  return { message, raw: message }
}

function detectAutomationStartupIssue(rawMessage) {
  const message = String(rawMessage || '').trim()
  if (!message) {
    return null
  }

  if (!/TypeError|Cannot read property|Cannot read properties/iu.test(message)) {
    return null
  }

  if (!/MinTabbarCount|getPreCompileOptions|checkTabbar|miniprogram-builder|appJSON\.js|checkAppFields\.js/iu.test(message)) {
    return null
  }

  return {
    message: 'DevTools 已启动，但当前项目在编译阶段失败（builder/checkTabbar）；这不是普通的 session/port 冲突。请先在微信开发者工具里确认当前项目能编译通过，再重试 open/connect。若终端里出现 checkTabbar、MinTabbarCount、getPreCompileOptions，优先检查 tabBar/custom-tab-bar 相关改动。',
    raw: message,
  }
}

function parseAutomationCliFailure(result, config: AnyRecord = {}) {
  const raw = String((result && result.raw) || `${(result && result.stdout) || ''}${(result && result.stderr) || ''}`).trim()

  if (result && result.error) {
    const detail = result.error && result.error.message ? result.error.message : String(result.error)
    return {
      code: 'DEVTOOLS_CLI_ERROR',
      message: `Failed to start WeChat DevTools CLI: ${config.cliPath || '(empty)'}. ${detail}`,
      hint: detail,
      raw,
    }
  }

  if (/QR_PATH_NOT_VALID_OR_NOT_EXIST|二维码输出路径无效或不存在|code:\s*17|\[error\]\s*code:\s*17/iu.test(raw)) {
    return {
      code: 'DEVTOOLS_CLI_ERROR',
      message: 'WeChat DevTools CLI reported code 17 / QR_PATH_NOT_VALID_OR_NOT_EXIST. This is commonly triggered when DevTools receives an unsupported project path, especially a WSL UNC path. Put the project under /mnt/<drive>/..., pass --devtools-project <Windows drive path>, or configure --project-map <linux=windows> / WECHAT_DEVTOOLS_PROJECT_MAP for a transparent WSL prefix mapping.',
      hint: 'code=17; QR_PATH_NOT_VALID_OR_NOT_EXIST',
      raw,
    }
  }

  if (/^\s*\[error\]/imu.test(raw)) {
    const firstErrorLine = raw.split(/\r?\n/u).find((line) => /^\s*\[error\]/iu.test(line)) || raw
    return {
      code: 'DEVTOOLS_CLI_ERROR',
      message: `WeChat DevTools CLI reported an error: ${firstErrorLine.trim()}`,
      hint: firstErrorLine.trim(),
      raw,
    }
  }

  if (result && result.status !== 0) {
    return formatAutomationCliError(raw || `WeChat DevTools CLI exited with status ${result.status}`)
  }

  return null
}

function detectAutomationCliProgressTimeout(result) {
  if (!result || !result.error) {
    return null
  }

  const detail = result.error && result.error.message ? String(result.error.message) : String(result.error)
  if (!/ETIMEDOUT|timed out/iu.test(detail)) {
    return null
  }

  const raw = String(result.raw || `${result.stdout || ''}${result.stderr || ''}`)
  if (!/IDE server has started, listening on http:\/\/127\.0\.0\.1:|long connection established|Using AppID:/iu.test(raw)) {
    return null
  }

  return {
    raw: raw.trim(),
    message: detail,
  }
}

function wrapConnectErrorWithStartupIssue(error, startupIssue) {
  if (!startupIssue || !startupIssue.message) {
    return error
  }

  const detail = error && error.message ? String(error.message).trim() : String(error || '').trim()
  const nextError = new Error(`${startupIssue.message}${detail ? `\n原始 connect 错误: ${detail}` : ''}`) as ErrorWithMeta
  nextError.raw = startupIssue.raw || detail
  nextError.cause = error
  return nextError
}

function parseResolvedIdePort(rawMessage) {
  const message = String(rawMessage || '')
  const match = message.match(/IDE server has started, listening on http:\/\/127\.0\.0\.1:(\d+)/iu)
  return match ? String(match[1]) : ''
}

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

function resolveAwaitTimeoutMs(condition, explicitTimeout) {
  const numericTimeout = Number(explicitTimeout)
  if (Number.isFinite(numericTimeout) && numericTimeout > 0) {
    return numericTimeout
  }

  const kind = condition && condition.kind ? String(condition.kind) : ''
  return DEFAULT_AWAIT_TIMEOUTS[kind] || 12000
}

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

function selectLogSummaryLine(lines) {
  const ranked = lines
    .map((line, index) => ({ line, index, score: scoreLogSummaryLine(line) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
  return ranked.length ? ranked[0].line : ''
}

function truncateLogSummaryLine(line, maxLength) {
  if (line.length <= maxLength) {
    return line
  }
  return `${line.slice(0, maxLength - 3)}...`
}

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

function parseCallArguments(rawArgs) {
  return (rawArgs || []).map((item) => {
    if (item === undefined) {
      return item
    }

    try {
      return JSON.parse(item)
    } catch (_) {
      return item
    }
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

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

function requireAutomator(config) {
  return require('miniprogram-automator')
}

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

function automationWsEndpoint(config) {
  return `ws://127.0.0.1:${config.autoPort}`
}

async function connectAutomationTool(automator, config) {
  const endpoint = automationWsEndpoint(config)
  if (automator && automator.launcher && typeof automator.launcher.connectTool === 'function') {
    return await automator.launcher.connectTool({ wsEndpoint: endpoint })
  }
  return await automator.connect({ wsEndpoint: endpoint })
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

async function connectOrEnable(config, options: AnyRecord = {}, overrides: AnyRecord = {}) {
  const connect = overrides.connect || connectWithRetry
  const enable = overrides.enable || enableAutomation
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

function clearStoredRuntimeEvents(state, kind) {
  if (kind === 'exception') {
    state.exceptionEvents = []
    return
  }
  state.consoleEvents = []
}

async function getSystemInfo(miniProgram) {
  return miniProgram.systemInfo()
}

async function getPageStack(miniProgram) {
  const stack = await miniProgram.pageStack()
  return (stack || []).map((page) => ({
    path: page.path,
    query: page.query,
  }))
}

function normalizeQueryForSignature(query) {
  if (!query || typeof query !== 'object') {
    return ''
  }

  return Object.keys(query)
    .sort()
    .map((key) => `${key}=${String(query[key])}`)
    .join('&')
}

function buildPageStackSignature(stack = []) {
  return (stack || [])
    .map((item) => `${normalizeRuntimeRoute(item && item.path ? item.path : '')}?${normalizeQueryForSignature(item && item.query)}`)
    .join('>')
}

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

function buildRuntimeStableTimeoutError(timeoutMs, hint, details: AnyRecord = {}) {
  const error = new Error(`runtime stable timed out after ${timeoutMs}ms`) as ErrorWithMeta
  error.code = 'RUNTIME_UNSTABLE'
  error.runtimeMayContinue = true
  error.hint = hint || 'phase=stable'
  error.diagnostics = details
  error.next = 'await stable'
  return error
}

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

async function getRuntimeAppConfig(miniProgram) {
  if (typeof miniProgram.evaluate !== 'function') {
    return {
      pages: [],
      tabBar: { list: [] },
      subPackages: [],
    }
  }

  const result = await miniProgram.evaluate(`function () {
    const config = typeof __wxConfig !== 'undefined' ? __wxConfig : {}
    return {
      pages: Array.isArray(config.pages) ? config.pages : [],
      tabBar: config.tabBar || { list: [] },
      subPackages: Array.isArray(config.subPackages) ? config.subPackages : [],
    }
  }`)

  return result || {
    pages: [],
    tabBar: { list: [] },
    subPackages: [],
  }
}

async function callWxMethod(miniProgram, method, rawArgs = []) {
  return miniProgram.callWxMethod(method, ...parseCallArguments(rawArgs))
}

async function callPageMethod(page, method, rawArgs = []) {
  return page.callMethod(method, ...parseCallArguments(rawArgs))
}

async function evaluateInMiniProgram(miniProgram, source) {
  const script = String(source || '').trim()
  if (!script) {
    throw new Error('eval requires JavaScript source')
  }

  const functionDeclaration = /^async\s+function\b/u.test(script) || /^function\b/u.test(script)
    ? script
    : /(^|\s)return\b/u.test(script) || /[;\n]/u.test(script)
      ? `function () { ${script} }`
      : `function () { return (${script}) }`

  return miniProgram.evaluate(functionDeclaration)
}

async function callNativeMethod(miniProgram, method, rawArgs = []) {
  if (!method) {
    throw new Error('native requires a method name')
  }

  const native = miniProgram.native()
  const handler = native && native[method]
  if (typeof handler !== 'function') {
    throw new Error(`Unknown native method: ${method}`)
  }

  return handler.apply(native, parseCallArguments(rawArgs))
}

async function getElementAttribute(element, name) {
  if (!name) {
    throw new Error('get attr requires an attribute name')
  }

  return element.attribute(name)
}

async function getElementProperty(element, name) {
  if (!name) {
    throw new Error('get prop requires a property name')
  }

  return element.property(name)
}

async function getElementRect(element) {
  const [size, offset] = await Promise.all([
    element.size(),
    element.offset(),
  ])

  return { size, offset }
}

async function ensureRouteTimelineMonitor(miniProgram) {
  if (typeof miniProgram.evaluate !== 'function') {
    return { installed: false, supported: false }
  }

  return miniProgram.evaluate(() => {
    const globalObject = globalThis
    const getCurrentPath = () => {
      try {
        if (typeof getCurrentPages !== 'function') {
          return ''
        }
        const pages = getCurrentPages()
        const currentPage = Array.isArray(pages) ? pages[pages.length - 1] : null
        return currentPage && currentPage.route ? String(currentPage.route).replace(/^\//, '') : ''
      } catch (_) {
        return ''
      }
    }

    globalObject.__MPB_ROUTE_EVENTS__ = Array.isArray(globalObject.__MPB_ROUTE_EVENTS__)
      ? globalObject.__MPB_ROUTE_EVENTS__
      : []
    globalObject.__MPB_ROUTE_SEQ__ = Number(globalObject.__MPB_ROUTE_SEQ__ || 0)
    globalObject.__MPB_LAST_ROUTE_PATH__ = globalObject.__MPB_LAST_ROUTE_PATH__ || getCurrentPath()

    if (globalObject.__MPB_ROUTE_MONITOR_INSTALLED__) {
      return { installed: true, supported: typeof wx !== 'undefined' && typeof wx.onAppRoute === 'function' }
    }

    if (typeof wx === 'undefined' || typeof wx.onAppRoute !== 'function') {
      return { installed: false, supported: false }
    }

    wx.onAppRoute((res: any = {}) => {
      const from = String(globalObject.__MPB_LAST_ROUTE_PATH__ || '').replace(/^\//, '')
      const to = String(res.path || '').replace(/^\//, '')
      const openType = String(res.openType || 'route')
      globalObject.__MPB_ROUTE_SEQ__ += 1
      globalObject.__MPB_ROUTE_EVENTS__.push({
        seq: globalObject.__MPB_ROUTE_SEQ__,
        ts: Date.now(),
        from,
        to,
        openType,
      })
      if (globalObject.__MPB_ROUTE_EVENTS__.length > 200) {
        globalObject.__MPB_ROUTE_EVENTS__ = globalObject.__MPB_ROUTE_EVENTS__.slice(-200)
      }
      if (to) {
        globalObject.__MPB_LAST_ROUTE_PATH__ = to
      }
    })

    globalObject.__MPB_ROUTE_MONITOR_INSTALLED__ = true
    return { installed: true, supported: true }
  })
}

async function syncRouteTimelineEvents(miniProgram, state) {
  if (typeof miniProgram.evaluate !== 'function') {
    return { events: [], lastSeq: Number(state.lastRouteEventSeq || 0) }
  }

  const rawEvents = await miniProgram.evaluate(() => {
    return Array.isArray(globalThis.__MPB_ROUTE_EVENTS__) ? globalThis.__MPB_ROUTE_EVENTS__ : []
  })
  const lastSeenSeq = Number(state.lastRouteEventSeq || 0)
  const events = (Array.isArray(rawEvents) ? rawEvents : [])
    .map(normalizeRouteTimelineEvent)
    .filter((event) => event.seq > lastSeenSeq)
  const nextSeq = events.length ? events[events.length - 1].seq : lastSeenSeq

  state.routeEvents = [
    ...(Array.isArray(state.routeEvents) ? state.routeEvents : []),
    ...events.map(({ seq, ...rest }) => rest),
  ].slice(-ROUTE_TIMELINE_LIMIT)
  state.lastRouteEventSeq = nextSeq

  return {
    events,
    lastSeq: nextSeq,
  }
}

function getStoredRouteTimeline(state, options: AnyRecord = {}) {
  const events = Array.isArray(state.routeEvents) ? state.routeEvents : []
  const limit = Number(options.limit || 20)
  if (!Number.isFinite(limit) || limit <= 0) {
    return events
  }
  return events.slice(-limit)
}

function clearStoredRouteTimeline(state) {
  state.routeEvents = []
}

async function getCurrentPage(miniProgram) {
  const page = await miniProgram.currentPage()
  if (!page) {
    throw new Error('No current page')
  }
  return page
}

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

function collectTagNamesFromWxml(wxml) {
  const tags = new Set(RUNTIME_SNAPSHOT_SEED_TAGS)
  const regex = /<([a-zA-Z][\w-]*)\b/gu
  let match

  while ((match = regex.exec(wxml || '')) !== null) {
    tags.add(match[1])
  }

  return [...tags]
}

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

function normalizeRuntimeText(value) {
  return String(value || '').replace(/\s+/gu, ' ').trim()
}

function deriveRuntimeBusinessKey(attributes) {
  if (attributes['data-sid']) {
    return `data-sid:${attributes['data-sid']}`
  }

  if (attributes.id) {
    return `id:${attributes.id}`
  }

  return null
}

function deriveRuntimeSelector(tagName, attributes) {
  if (attributes.id) {
    return `[id="${String(attributes.id).replace(/(["\\])/gu, '\\$1')}"]`
  }

  if (attributes['data-sid']) {
    return `[data-sid="${attributes['data-sid']}"]`
  }

  return tagName
}

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

function isInteractiveRuntimeNode(node) {
  return INTERACTIVE_RUNTIME_TAGS.has(node.kind)
    || node.kind === 'button'
}

function isContentRuntimeNode(node) {
  return CONTENT_RUNTIME_TAGS.has(node.tagName) && Boolean(normalizeRuntimeText(node.text))
}

function isStructuralRuntimeNode(node) {
  return STRUCTURAL_RUNTIME_TAGS.has(node.tagName)
}

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

function buildNodeStableKey(pageKey, route, node) {
  if (!node || typeof node !== 'object') {
    return ''
  }

  const stablePath = node.canonicalPath ? String(node.canonicalPath) : ''
  return stablePath ? `${pageKey || route}|${stablePath}` : ''
}

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

function findNodeByStableKey(nodes, pageKey, route, stableKey) {
  if (!stableKey) {
    return null
  }
  return findFirstNode(nodes, (node) => buildNodeStableKey(pageKey, route, node) === stableKey)
}

function selectorIndexInSubtree(nodes, targetNode) {
  if (!targetNode || !targetNode.selector) {
    return 0
  }
  const matches = collectMatchingNodes(nodes, (candidate) => candidate.selector === targetNode.selector)
  return Math.max(matches.indexOf(targetNode), 0)
}

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

function collectMatchingNodes(nodes, predicate, collected = []) {
  for (const node of nodes || []) {
    if (predicate(node)) {
      collected.push(node)
    }
    collectMatchingNodes(node.children || [], predicate, collected)
  }
  return collected
}

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

function isRefToken(value) {
  return /^@e\d+$/u.test(value)
}

async function resolveRecord(page, state, record, seen = new Set()) {
  if (!record || !record.strategy) {
    throw new Error('Invalid ref record')
  }

  if (record.route && page.path && record.route !== page.path) {
    throw new Error(`Ref route mismatch: ${record.ref} belongs to ${record.route}, current page is ${page.path}`)
  }

  if (seen.has(record.ref)) {
    throw new Error(`Cyclic ref dependency: ${record.ref}`)
  }

  seen.add(record.ref)

  let scope = page
  if (record.scopeRef) {
    const scopeRecord = state.refs[record.scopeRef]
    if (!scopeRecord) {
      throw new Error(`Missing scope ref: ${record.scopeRef}`)
    }
    scope = await resolveRecord(page, state, scopeRecord, seen)
  }

  let selector = record.strategy.selector
  let index = Number(record.strategy.index || 0)
  let matchedNode = null
  const needsFreshTree = Boolean(record.stableKey)
    || !selector
    || ['registry', 'testid', 'business', 'scope'].includes(record.strategy.kind)

  if (needsFreshTree) {
    const treeData = await readRuntimeTree(page)
    const canonicalTree = assignCanonicalPaths(treeData ? treeData.nodes : [])
    const pageKey = treeData ? treeData.pageKey : ''
    const scopeTree = record.scopeRef
      ? subtreeForScope(canonicalTree, state.refs[record.scopeRef], pageKey)
      : canonicalTree

    matchedNode = findNodeByStableKey(scopeTree, pageKey, page.path, record.stableKey)
    const matchedByStableKey = Boolean(matchedNode)
    if (!matchedNode) {
      matchedNode = findFirstNode(scopeTree, (candidate) => matchesRecord(candidate, record))
    }

    if (!matchedNode) {
      throw new Error(`Ref is stale or no longer resolvable: ${record.ref}; page likely changed, run snapshot -i again.`)
    }

    const currentSignature = buildRuntimeRecordSignature(matchedNode)
    if (!matchedByStableKey && record.signature && currentSignature && record.signature !== currentSignature) {
      throw new Error(`Ref is stale: ${record.ref} no longer points to the same UI element; run snapshot -i again.`)
    }

    selector = matchedNode.selector || selector
    index = selectorIndexInSubtree(scopeTree, matchedNode)
  }

  if (!selector) {
    throw new Error(`Ref is not resolvable without selector: ${record.ref}; run snapshot -i again.`)
  }

  const elements = await scope.$$(selector)
  if (matchedNode && elements.length > 1) {
    const stableText = resolveRuntimeStableText(matchedNode)
    if (stableText) {
      for (let candidateIndex = 0; candidateIndex < elements.length; candidateIndex += 1) {
        const candidateText = resolveRuntimeStableText({ text: await elements[candidateIndex].text().catch(() => '') })
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

async function resolveTarget(page, state, token, scopeRef = null) {
  if (isRefToken(token)) {
    const record = state.refs[token]
    if (!record) {
      throw new Error(`Unknown ref: ${token}`)
    }
    return resolveRecord(page, state, record)
  }

  let scope = page
  if (scopeRef) {
    const scopeRecord = state.refs[scopeRef]
    if (!scopeRecord) {
      throw new Error(`Unknown scope ref: ${scopeRef}`)
    }
    scope = await resolveRecord(page, state, scopeRecord)
  }

  const element = await scope.$(token)
  if (!element) {
    throw new Error(`Selector not found: ${token}`)
  }
  return element
}

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

function ensureNextRefIndex(state, nextRefIndex) {
  return {
    ...state,
    nextRefIndex: Math.max(Number(state.nextRefIndex || 1), Number(nextRefIndex || 1)),
  }
}

function nextEpoch(state) {
  return Number(state.epoch || 0) + 1
}

async function snapshotInteractive(page, state, scopeRef = null, snapshotOptions: AnyRecord = {}) {
  const treeData = await readRuntimeTree(page)
  if (!treeData) {
    throw new Error('No snapshot tree available for snapshot -i')
  }
  const scopeRecord = scopeRef ? state.refs[scopeRef] : null
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

async function queryRecords(page, state, mode, value, scopeRef = null) {
  const epoch = state.epoch || 0
  const route = page.path
  const startIndex = state.nextRefIndex || 1

  if (mode === 'selector') {
    const scope = scopeRef ? await resolveRecord(page, state, state.refs[scopeRef]) : page
    const elements = await scope.$$(value)
    const records = []
    for (let index = 0; index < elements.length; index += 1) {
      const element = elements[index]
      records.push({
        ref: `@e${startIndex + index}`,
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
        kind: element.tagName || 'custom',
        text: await element.text().catch(() => ''),
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

  const scopeRecord = scopeRef ? state.refs[scopeRef] : null
  const subtree = subtreeForScope(treeData.nodes, scopeRecord)
  const predicate = (node) => {
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

  const records = built.records.filter((record) => {
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
  sleep,
  withMiniProgram,
  withTimeout,
  captureScreenshotToPath,
  cleanupMiniProgram,
  shutdownMiniProgram,
  getCurrentPage,
  getSystemInfo,
  getRuntimeAppConfig,
  getPageStack,
  confirmRouteAfterAction,
  callWxMethod,
  callPageMethod,
  evaluateInMiniProgram,
  callNativeMethod,
  getElementAttribute,
  getElementProperty,
  getElementRect,
  ensureRouteTimelineMonitor,
  syncRouteTimelineEvents,
  getStoredRouteTimeline,
  clearStoredRouteTimeline,
  syncCurrentRoute,
  getStoredRuntimeEvents,
  clearStoredRuntimeEvents,
  formatRuntimeEventLines,
  formatRouteTimelineLine,
  buildNativeDiagnostic,
  buildClickNotices,
  formatAutomationCliError,
  parseAutomationCliFailure,
  detectAutomationCliProgressTimeout,
  validateAutomationCliConfig,
  normalizeAwaitCondition,
  resolveAwaitTimeoutMs,
  extractLogSummary,
  enableAutomation,
  closeDevtoolsProject,
  cleanupWindowsProjectAutoLink,
  cleanupWindowsProjectMirror,
  isWindowsProjectMirrorDrained,
  findManagedWindowsProjectMirrors,
  parseResolvedIdePort,
  formatConsoleEventLine,
  formatExceptionEventLine,
  readRuntimeTree,
  applySnapshotOptions,
  subtreeForScope,
  ensureNextRefIndex,
  resolveRecord,
  resolveTarget,
  snapshotInteractive,
  queryRecords,
  isRefToken,
  buildAutomationArgs,
  connectWithRetry,
  isAutomationEndpointLive,
  buildConnectRetryOptions,
  connectOrEnable,
  probeAutomationRuntime,
  sendAutomationProtocol,
  collectDevtoolsLogs,
  resolveDevtoolsLogRoot,
  waitForMiniProgramStable,
  waitForMiniProgramCondition,
}
