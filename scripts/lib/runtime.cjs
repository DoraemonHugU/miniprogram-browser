const { mkdir } = require('node:fs/promises')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const {
  buildTreeSnapshotRecords,
  createRefRecordFromNode,
  formatSnapshotLines,
} = require('./core.cjs')

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

function wrapConnectErrorWithStartupIssue(error, startupIssue) {
  if (!startupIssue || !startupIssue.message) {
    return error
  }

  const detail = error && error.message ? String(error.message).trim() : String(error || '').trim()
  const nextError = new Error(`${startupIssue.message}${detail ? `\n原始 connect 错误: ${detail}` : ''}`)
  nextError.raw = startupIssue.raw || detail
  nextError.cause = error
  return nextError
}

function parseResolvedIdePort(rawMessage) {
  const message = String(rawMessage || '')
  const match = message.match(/IDE server has started, listening on http:\/\/127\.0\.0\.1:(\d+)/iu)
  return match ? String(match[1]) : ''
}

function buildNativeDiagnostic(method, result, context = {}) {
  const errorMessage = result && result.error && result.error.message
  const routeNotices = (context.routeEvents || []).map(formatRouteTimelineLine)
  const diagnostic = {
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

function toWindowsPath(inputPath) {
  if (!inputPath.startsWith('/')) {
    return inputPath
  }

  const result = spawnSync('wslpath', ['-w', inputPath], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`Failed to convert path with wslpath: ${inputPath}`)
  }

  return result.stdout.trim()
}

function buildAutomationArgs(config) {
  const hasWindowsBundle = config.cliPath.endsWith('.bat')
  const args = [
    'auto',
    '--project',
    hasWindowsBundle ? toWindowsPath(config.projectPath) : config.projectPath,
    '--auto-port',
    String(config.autoPort),
  ]

  if (String(config.devtoolsPort || '').trim()) {
    args.push('--port', String(config.devtoolsPort))
  }

  return {
    hasWindowsBundle,
    args,
  }
}

function runAutomationCli(config) {
  const cliDirectory = path.dirname(config.cliPath)
  const nodeExePath = path.join(cliDirectory, 'node.exe')
  const cliJsPath = path.join(cliDirectory, 'cli.js')
  const { hasWindowsBundle, args } = buildAutomationArgs(config)

  const result = hasWindowsBundle
    ? spawnSync(nodeExePath, [
      toWindowsPath(cliJsPath),
      ...args,
    ], {
      encoding: 'utf8',
      timeout: 30000,
    })
    : spawnSync(config.cliPath, args, {
      encoding: 'utf8',
      timeout: 30000,
    })

  return {
    ...result,
    raw: `${result.stdout || ''}${result.stderr || ''}`.trim(),
  }
}

function enableAutomation(config) {
  const result = runAutomationCli(config)
  const startupIssue = detectAutomationStartupIssue(result.raw)

  if (result.status !== 0) {
    const formatted = formatAutomationCliError(result.raw)
    const error = new Error(formatted.message)
    error.raw = formatted.raw
    throw error
  }

  const resolvedDevtoolsPort = parseResolvedIdePort(result.raw)
  if (!String(config.devtoolsPort || '').trim() && resolvedDevtoolsPort) {
    const pinnedConfig = { ...config, devtoolsPort: resolvedDevtoolsPort }
    const pinnedResult = runAutomationCli(pinnedConfig)
    if (pinnedResult.status === 0) {
      config.devtoolsPort = resolvedDevtoolsPort
    } else {
      config.devtoolsPort = resolvedDevtoolsPort
    }
  }

  return { resolvedDevtoolsPort, startupIssue }
}

async function connectWithRetry(config) {
  const automator = requireAutomator(config)
  let lastError

  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      return await automator.connect({
        wsEndpoint: `ws://127.0.0.1:${config.autoPort}`,
      })
    } catch (error) {
      lastError = error
      await sleep(1000)
    }
  }

  throw lastError
}

async function connectOrEnable(config, options = {}, overrides = {}) {
  const connect = overrides.connect || connectWithRetry
  const enable = overrides.enable || enableAutomation
  const sleepFn = overrides.sleepFn || sleep
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null

  if (options.preferEnable) {
    onProgress && onProgress('enable')
    const metadata = enable(config) || {}
    if (!String(config.devtoolsPort || '').trim() && metadata.resolvedDevtoolsPort) {
      config.devtoolsPort = metadata.resolvedDevtoolsPort
    }
    await sleepFn(5000)
    onProgress && onProgress('connect')
    try {
      return await connect(config)
    } catch (error) {
      throw wrapConnectErrorWithStartupIssue(error, metadata.startupIssue)
    }
  }

  try {
    onProgress && onProgress('connect')
    return await connect(config)
  } catch (_) {
    onProgress && onProgress('enable')
    const metadata = enable(config) || {}
    if (!String(config.devtoolsPort || '').trim() && metadata.resolvedDevtoolsPort) {
      config.devtoolsPort = metadata.resolvedDevtoolsPort
    }
    await sleepFn(5000)
    onProgress && onProgress('connect')
    try {
      return await connect(config)
    } catch (error) {
      throw wrapConnectErrorWithStartupIssue(error, metadata.startupIssue)
    }
  }
}

async function withMiniProgram(state, task, options = {}) {
  if (!state.config || !String(state.config.projectPath || '').trim()) {
    throw new Error('Missing project path. Pass --project <miniprogram-root> on first open/session binding.')
  }
  await mkdir(state.config.screenshotDir, { recursive: true })
  await mkdir(state.config.tempScreenshotDir, { recursive: true })
  const miniProgram = await connectOrEnable(state.config, {
    preferEnable: options.preferEnable !== undefined
      ? Boolean(options.preferEnable)
      : Boolean(state.portResolution && state.portResolution.autoPortAssigned),
    onProgress: options.onProgress,
  })
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
    await ensureRouteTimelineMonitor(miniProgram)
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
    await syncCurrentRoute(state, miniProgram)
    await cleanupMiniProgram(miniProgram)
  }
}

function getStoredRuntimeEvents(state, kind, options = {}) {
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

    wx.onAppRoute((res = {}) => {
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

function getStoredRouteTimeline(state, options = {}) {
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

function applySnapshotOptions(nodes, options = {}) {
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

async function readRuntimeTree(page, options = {}) {
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

function subtreeForScope(tree, scopeRecord) {
  if (!scopeRecord) {
    return tree
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
  if (!selector && ['registry', 'testid', 'business', 'scope'].includes(record.strategy.kind)) {
    const treeData = await readRuntimeTree(page)
    const node = findFirstNode(treeData ? treeData.nodes : [], (candidate) => matchesRecord(candidate, record))
    selector = node && node.selector ? node.selector : null
  }

  if (!selector) {
    throw new Error(`Ref is not resolvable without selector: ${record.ref}`)
  }

  const elements = await scope.$$(selector)
  const index = Number(record.strategy.index || 0)
  if (elements.length <= index) {
    throw new Error(`Resolved selector not found: ${selector} at index ${index}`)
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

async function snapshotInteractive(page, state, scopeRef = null, snapshotOptions = {}) {
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
  parseResolvedIdePort,
  formatConsoleEventLine,
  formatExceptionEventLine,
  readRuntimeTree,
  applySnapshotOptions,
  ensureNextRefIndex,
  resolveRecord,
  resolveTarget,
  snapshotInteractive,
  queryRecords,
  isRefToken,
  buildAutomationArgs,
  connectOrEnable,
}
