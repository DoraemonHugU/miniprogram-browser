#!/usr/bin/env node

const path = require('node:path')

type AnyRecord = Record<string, any>

const DEFAULT_OPEN_TIMEOUT_MS = 120000
const DEFAULT_OPEN_STABLE_TIMEOUT_MS = 15000
const DEFAULT_OPEN_AUTO_PORT_ATTEMPTS = 3
const DEVTOOLS_CLOSE_GRACE_MS = Math.max(0, Number(process.env.MINIPROGRAM_BROWSER_CLOSE_GRACE_MS || 3500))
const TRANSIENT_DOCTOR_SESSION = '__doctor__'

const {
  normalizeRoutePath,
  normalizeInspectSections,
  inspectProjectStructure,
  formatInspectLines,
} = require('./lib/app-inspect')

const {
  createVisualProbe,
  buildVisualDiffSummary,
  collectRecordRects,
} = require('./lib/visual-change')

const {
  formatSnapshotLines,
} = require('./lib/core')

const {
  renderAsciiMap,
} = require('./lib/ascii-map')

const {
  emit,
  emitProgress,
  parseArgs,
  parseFocusRefs,
} = require('./lib/cli-io')

const {
  buildCommandHelpText,
  buildHelpText,
  getVersionText,
} = require('./lib/cli-help')

const {
  summarizeSnapshotPayload,
  summarizeTimelinePayload,
} = require('./lib/cli-payload')

const {
  assertBindingConsistency,
  assignPorts,
  assertProjectPath,
  acquireSessionLock,
  createEmptySessionState,
  createDefaultConfig,
  ensureSessionPorts,
  listRuntimeLaunches,
  listSessionStates,
  loadOtherSessionConfigs,
  mergeConfigOverrides,
  loadSessionState,
  recordRuntimeLaunch,
  updateRuntimeLaunch,
  removeRuntimeLaunch,
  saveSessionState,
  clearSessionState,
  releaseSessionLock,
  resolveSessionConfig,
  resolveMiniProgramProjectInfo,
  discoverMiniProgramProjectFromCwd,
  validateSessionPortConflicts,
  runtimeLockName,
  selectAttachableRuntimeSession,
  shouldShutdownRuntimeOnClose,
} = require('./lib/session-store')

const {
  captureScreenshotToPath,
  sleep,
  shutdownMiniProgram,
  withMiniProgram,
  getCurrentPage,
  getSystemInfo,
  getRuntimeAppConfig,
  confirmRouteAfterAction,
  readRuntimeTree,
  getPageStack,
  callWxMethod,
  callPageMethod,
  evaluateInMiniProgram,
  callNativeMethod,
  getElementAttribute,
  getElementProperty,
  getElementRect,
  syncRouteTimelineEvents,
  getStoredRouteTimeline,
  clearStoredRouteTimeline,
  formatRouteTimelineLine,
  getStoredRuntimeEvents,
  clearStoredRuntimeEvents,
  formatRuntimeEventLines,
  formatConsoleEventLine,
  formatExceptionEventLine,
  buildNativeDiagnostic,
  buildClickNotices,
  buildAutomationArgs,
  enableAutomation,
  extractLogSummary,
  normalizeAwaitCondition,
  probeAutomationRuntime,
  resolveAwaitTimeoutMs,
  sendAutomationProtocol,
  collectDevtoolsLogs,
  closeDevtoolsProject,
  isAutomationEndpointLive,
  resolveTarget,
  snapshotInteractive,
  queryRecords,
  isRefToken,
  waitForMiniProgramStable,
  waitForMiniProgramCondition,
} = require('./lib/runtime')

const {
  captureAnnotatedScreenshot,
  captureLayoutScreenshot,
  overlayFocusScreenshot,
  readOfficialMenuButtonRect,
  captureVisualScreenshot,
} = require('./lib/visual')

function mergeRecordLayouts(records, rects) {
  const identityOf = (item) => item && (item.ref || item.businessKey || item.selector || '')
  const byRef = new Map((rects || []).map((item) => [identityOf(item), item.rectPct]))
  return (records || []).map((record) => ({
    ...record,
    ...(byRef.has(identityOf(record)) ? { rectPct: byRef.get(identityOf(record)) } : {}),
  }))
}

function flattenRuntimeNodes(nodes, parentRef = '') {
  const flattened = []
  for (const node of nodes || []) {
    const current = {
      ...node,
      parentRef,
    }
    flattened.push(current)
    flattened.push(...flattenRuntimeNodes(node.children || [], current.ref || current.businessKey || ''))
  }
  return flattened
}

function shouldEmitPreludeNotices(command) {
  return !['logs', 'exceptions', 'await', 'wait'].includes(String(command || ''))
}

/**
 * @param {any} state
 * @param {string} route
 * @param {string|null} scopeRef
 * @param {any} [options]
 */
function shouldAttemptVisualProbe(state, route, scopeRef = null, options) {
  if (!options || !options.visual) {
    return false
  }

  if (scopeRef) {
    return false
  }

  if (state.pendingVisualAction) {
    return true
  }

  if (!state.lastVisualProbe) {
    return true
  }

  return state.lastVisualProbe.route !== route
}

function markPendingVisualAction(state, action, route) {
  state.pendingVisualAction = {
    action,
    route,
    ts: Date.now(),
  }
}

async function captureVisualProbeForSnapshot(miniProgram, page, state, records, screenshotPath) {
  try {
    return await createVisualProbe({
      miniProgram,
      page,
      records,
      config: state.config,
      screenshotPath,
      cleanupScreenshot: Boolean(screenshotPath),
      captureScreenshot: async (instance, targetPath) => captureScreenshotToPath(instance, targetPath, 2500),
    })
  } catch (_) {
    return null
  }
}

function maybeBuildImplicitVisualChange(state, currentProbe) {
  const pending = state.pendingVisualAction
  const previous = state.lastVisualProbe
  if (!pending || !previous || !currentProbe) {
    state.lastVisualProbe = currentProbe || state.lastVisualProbe || null
    state.pendingVisualAction = null
    return null
  }

  let visual = null
  if (pending.route === currentProbe.route && previous.route === currentProbe.route) {
    visual = buildVisualDiffSummary(previous, currentProbe)
  }

  state.lastVisualProbe = currentProbe
  state.pendingVisualAction = null
  return visual
}

function printHelp() {
  console.log(buildHelpText())
}

function printCommandHelp(command) {
  const help = buildCommandHelpText(command)
  if (!help) {
    throw new Error(`Unknown help topic: ${command}`)
  }
  console.log(help)
}

async function readStdin() {
  if (process.stdin.isTTY) {
    return ''
  }

  let content = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) {
    content += chunk
  }
  return content
}

function buildExplicitOverrides(options) {
  return {
    projectPath: options.project,
    devtoolsProjectPath: options.devtoolsProject,
    devtoolsProjectMap: options.projectMap,
    cliPath: options.cliPath,
    trustProject: options.trustProject,
    autoPort: options.autoPort,
    devtoolsPort: options.devtoolsPort,
  }
}

function withDiscoveredProjectScope(options, command) {
  if (options.project || options.all) {
    return options
  }

  const currentProject = discoverMiniProgramProjectFromCwd(process.cwd())
  if (!currentProject) {
    return options
  }

  return {
    ...options,
    project: currentProject.projectPath,
    projectDiscovered: true,
  }
}

async function resolveSession(options) {
  const baseConfig = mergeConfigOverrides(createDefaultConfig(), buildExplicitOverrides(options))
  const explicitOverrides = buildExplicitOverrides(options)
  const initialConfig = mergeConfigOverrides(baseConfig, explicitOverrides)
  const state = await loadSessionState(options.session, initialConfig)
  assertBindingConsistency(state.config || {}, explicitOverrides)
  state.config = mergeConfigOverrides(state.config || initialConfig, explicitOverrides)
  delete state.config.interactiveSelectors

  if (explicitOverrides.devtoolsPort || explicitOverrides.autoPort) {
    const otherConfigs = await loadOtherSessionConfigs(state.config, state.name)
    validateSessionPortConflicts(state.config, otherConfigs)
  }

  await ensureSessionPorts(state)
  return state
}

async function resolveTransientDoctorState(options) {
  const explicitOverrides = buildExplicitOverrides(options)
  const baseConfig = mergeConfigOverrides(createDefaultConfig(), explicitOverrides)
  const state = createEmptySessionState({
    sessionName: options.session || TRANSIENT_DOCTOR_SESSION,
    config: mergeConfigOverrides(baseConfig, explicitOverrides),
  })
  delete state.config.interactiveSelectors
  await ensureSessionPorts(state)
  return state
}

function resolveOpenTimeoutMs(options) {
  const value = Number(options.timeout || DEFAULT_OPEN_TIMEOUT_MS)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_OPEN_TIMEOUT_MS
}

function resolveOpenStableTimeoutMs(options) {
  const openTimeoutMs = resolveOpenTimeoutMs(options)
  return Math.max(1000, Math.min(DEFAULT_OPEN_STABLE_TIMEOUT_MS, Math.floor(openTimeoutMs / 2)))
}

function createOpenTimeoutError(timeoutMs) {
  const error = new Error(`open timed out after ${timeoutMs}ms`) as AnyRecord
  error.code = 'OPEN_TIMEOUT'
  error.hint = `phase=open; timeoutMs=${timeoutMs}`
  return error
}

async function withOpenTimeout(task, timeoutMs) {
  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(task),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(createOpenTimeoutError(timeoutMs)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

async function cleanupStartedOpenRuntime(state) {
  const closeResult = closeDevtoolsProject(state.config, { timeoutMs: 30000 })
  await waitAfterDevtoolsCloseRequest(closeResult)
  const cleanup = {
    projectClosed: Boolean(closeResult && closeResult.ok),
    closeVerified: false,
    closeAttempted: Boolean(closeResult && closeResult.attempted),
  } as AnyRecord

  if (closeResult && closeResult.reason) {
    cleanup.reason = closeResult.reason
  }
  if (closeResult && closeResult.error) {
    cleanup.error = closeResult.error
  }
  if (closeResult && closeResult.projectPath) {
    cleanup.devtoolsProjectPath = closeResult.projectPath
  }

  if (state.runtimeLaunchId) {
    cleanup.runtimeLaunchId = state.runtimeLaunchId
  }

  const canClearSession = shouldClearFailedOpenSession(closeResult)
  if (canClearSession || !cleanup.closeAttempted) {
    await clearSessionState(state.name, state.config)
    cleanup.sessionCleared = true
    if (state.runtimeLaunchId) {
      await removeRuntimeLaunch(state.runtimeLaunchId, state.config).catch(() => false)
    }
  } else {
    cleanup.sessionCleared = false
    await markStartedRuntimeLaunch(state, {
      status: 'cleanup-failed',
      cleanup,
    })
  }

  return cleanup
}

async function waitAfterDevtoolsCloseRequest(closeResult) {
  if (closeResult && closeResult.ok && DEVTOOLS_CLOSE_GRACE_MS > 0) {
    await sleep(DEVTOOLS_CLOSE_GRACE_MS)
  }
}

async function recordStartedRuntimeLaunch(state, metadata: AnyRecord = {}) {
  const automationArgs = buildAutomationArgs(state.config)
  const id = `${state.name}-${Date.now()}-${process.pid}`
  const record = await recordRuntimeLaunch(state.name, state.config, {
    id,
    status: 'starting',
    projectStrategy: automationArgs.projectStrategy,
    devtoolsProjectPath: automationArgs.devtoolsProjectPath,
    ...metadata,
  })
  if (record && record.id) {
    state.runtimeLaunchId = record.id
    state.runtimeLaunchStatus = 'starting'
  }
  return record
}

async function markStartedRuntimeLaunch(state, patch: AnyRecord = {}) {
  if (!state || !state.runtimeLaunchId) {
    return null
  }
  return await updateRuntimeLaunch(state.runtimeLaunchId, state.config, patch).catch(() => null)
}

async function enrichOpenFailure(error, state, options) {
  const openError = error || new Error('open failed')
  const genericTimeoutHint = `phase=open; timeoutMs=${resolveOpenTimeoutMs(options)}`
  if (openError && openError.code === 'AUTOMATION_CONNECT_TIMEOUT') {
    const timeoutError = createOpenTimeoutError(resolveOpenTimeoutMs(options))
    openError.message = timeoutError.message
    openError.code = timeoutError.code
    openError.hint = timeoutError.hint
  }
  const failureContext = await buildOpenFailureDiagnostics(state, options).catch(() => undefined)
  if (failureContext && failureContext.code && (!openError.code || openError.code === 'OPEN_TIMEOUT')) {
    openError.code = failureContext.code
  }
  if (failureContext && failureContext.diagnostics) {
    openError.diagnostics = failureContext.diagnostics
  }
  if (!openError.code && openError.runtimeNotReady) {
    openError.code = 'APP_NOT_READY'
  }
  if (failureContext && failureContext.hint && (!openError.hint || openError.hint === genericTimeoutHint)) {
    openError.hint = failureContext.hint
  }
  if (!openError.log && failureContext && failureContext.log) {
    openError.log = failureContext.log
  }
  if (!openError.next && failureContext && failureContext.next) {
    openError.next = failureContext.next
  }
  if (!openError.next && openError.log) {
    openError.next = 'devtools logs'
  }
  return openError
}

function shouldCleanupStartedOpenRuntime(state, openOptions: AnyRecord = {}, error: AnyRecord = {}) {
  if (error && error.runtimeMayContinue) {
    return false
  }
  return openOptions.mode === 'started' && !state.runtimeAttached
}

function shouldClearFailedOpenSession(closeResult) {
  if (!closeResult || !closeResult.attempted) {
    return true
  }
  return Boolean(closeResult.ok)
}

async function openSessionWithDiagnostics(state, options, openOptions: AnyRecord = {}) {
  try {
    return await connectOpenSession(state, options, openOptions)
  } catch (error) {
    const openError = await enrichOpenFailure(error, state, options)
    if (shouldCleanupStartedOpenRuntime(state, openOptions, openError)) {
      const cleanup = await cleanupStartedOpenRuntime(state).catch((cleanupError) => ({
        projectClosed: false,
        closeAttempted: false,
        sessionCleared: false,
        error: cleanupError && cleanupError.message ? String(cleanupError.message) : String(cleanupError),
      }))
      openError.diagnostics = {
        ...(openError.diagnostics || {}),
        cleanup,
      }
    }
    throw openError
  }
}

async function handleOpen(state, options) {
  if (!options.sessionProvided) {
    throw new Error('首次 open/connect 必须显式传 --session <name>。')
  }
  assertProjectPath(state.config)

  const currentEndpointLive = state.config.autoPort
    ? await isAutomationEndpointLive(state.config, { timeoutMs: 1000 }).catch(() => false)
    : false
  if (!currentEndpointLive && !options.fresh && !options.autoPort) {
    const attachResult = await resolveAttachableRuntime(state)
    if (attachResult.mode === 'attach') {
      attachStateToRuntime(state, attachResult.ownerState)
      await saveSessionState(state)
      const attached = await openSessionWithDiagnostics(state, options, {
        mode: 'attached',
        attachedTo: attachResult.ownerState.name,
      })
      emitOpenResult(attached, options)
      return
    }
    if (attachResult.mode === 'ambiguous') {
      const error = new Error('同项目存在多个 live automation session，open 不会静默选择；请显式使用其中一个 --session，或传 --fresh 尝试启动新 runtime。') as AnyRecord
      error.code = 'SESSION_CONFLICT'
      error.hint = `liveSameProjectSessions=${attachResult.sessions.length}; explicitSessionRequired`
      error.diagnostics = {
        projectPath: state.config.projectPath,
        liveSameProjectSessions: attachResult.sessions,
      }
      throw error
    }
  }

  const openMode = currentEndpointLive ? (state.runtimeAttached ? 'attached' : 'connected') : 'started'
  const attemptedAutoPorts = []
  let result

  for (let attempt = 1; attempt <= DEFAULT_OPEN_AUTO_PORT_ATTEMPTS; attempt += 1) {
    if (openMode === 'started') {
      await recordStartedRuntimeLaunch(state, {
        attempt,
        autoPort: state.config.autoPort,
      })
    }
    await saveSessionState(state)

    try {
      result = await openSessionWithDiagnostics(state, options, {
        mode: openMode,
        attachedTo: state.runtimeAttached ? state.runtimeOwnerSession : '',
      })
      break
    } catch (error) {
      if (!shouldRetryOpenWithAnotherAutoPort(state, options, openMode, error, attempt)) {
        error.diagnostics = {
          ...(error.diagnostics || {}),
          attemptedAutoPorts: [...attemptedAutoPorts, state.config.autoPort].filter(Boolean),
        }
        throw error
      }

      attemptedAutoPorts.push(state.config.autoPort)
      await reassignOpenAutoPort(state, attemptedAutoPorts)
    }
  }

  if (!result) {
    throw new Error('open failed without a result')
  }

  if (attemptedAutoPorts.length) {
    result.attemptedAutoPorts = [...attemptedAutoPorts, result.autoPort].filter(Boolean)
  }
  if (openMode === 'started') {
    await markStartedRuntimeLaunch(state, {
      status: 'live',
      route: result.path || '',
    })
  }
  await saveSessionState(state)
  emitOpenResult(result, options)
}

function shouldRetryOpenWithAnotherAutoPort(state, options, openMode, error: AnyRecord = {}, attempt = 1) {
  if (openMode !== 'started') {
    return false
  }
  if (!state || !state.portResolution || !state.portResolution.autoPortAssigned) {
    return false
  }
  if (options && options.autoPort) {
    return false
  }
  if (attempt >= DEFAULT_OPEN_AUTO_PORT_ATTEMPTS) {
    return false
  }

  const code = String(error.code || '').trim()
  if (code === 'APPID_MISSING') {
    return false
  }
  if (code === 'DEVTOOLS_AUTOMATION_SERVER_FAILED' || code === 'APP_LAUNCH_TIMEOUT' || code === 'WINDOWS_SOCKET_EXHAUSTED') {
    return false
  }
  const startupHintCodes = new Set(((error.diagnostics && error.diagnostics.startupHints) || []).map((item) => item && item.code).filter(Boolean))
  if (startupHintCodes.has('cli-server-start-error') || startupHintCodes.has('app-launch-timeout') || startupHintCodes.has('windows-socket-10055')) {
    return false
  }
  if (code === 'AUTOMATION_CONNECT_TIMEOUT') {
    return true
  }

  const message = String(error.message || '')
  if (/Failed connecting to ws:\/\/127\.0\.0\.1:/iu.test(message)) {
    return true
  }

  const causeMessage = String(error && error.cause && error.cause.message ? error.cause.message : '')
  return /Failed connecting to ws:\/\/127\.0\.0\.1:/iu.test(causeMessage)
}

async function reassignOpenAutoPort(state, attemptedAutoPorts = []) {
  const otherConfigs = await loadOtherSessionConfigs(state.config, state.name)
  const retryReservations = (attemptedAutoPorts || [])
    .filter(Boolean)
    .map((autoPort) => ({ autoPort }))
  state.config = await assignPorts({
    ...state.config,
    autoPort: '',
    devtoolsProjectPath: '',
    devtoolsProjectMirror: '',
    devtoolsProjectAutoLink: '',
  }, [...otherConfigs, ...retryReservations])
  state.portResolution.autoPortAssigned = true
  return state.config.autoPort
}

function normalizeOpenStableWaitError(error: AnyRecord = {}) {
  if (!error || error.code !== 'RUNTIME_UNSTABLE') {
    throw error
  }

  return {
    stable: null,
    stableTimeout: {
      message: error.message,
      hint: error.hint,
      next: error.next,
      diagnostics: error.diagnostics,
    },
  }
}

async function connectOpenSession(state, options, openOptions: AnyRecord = {}) {
  return await withMiniProgram(state, async (miniProgram) => {
    const appReady = miniProgram.__mpbRuntimeReady !== false
    const runtimeProbe = miniProgram.__mpbRuntimeProbe || null
    if (!options.noAwait && appReady) {
      emitProgress('正在等待小程序运行态稳定...', options)
    }
    let stable = null
    let stableTimeout = null
    if (!options.noAwait && appReady) {
      try {
        stable = await waitForMiniProgramStable(miniProgram, {
          timeoutMs: resolveOpenStableTimeoutMs(options),
        })
      } catch (error) {
        const normalized = normalizeOpenStableWaitError(error)
        stable = normalized.stable
        stableTimeout = normalized.stableTimeout
      }
    }
    const page = appReady ? await getCurrentPage(miniProgram).catch(() => null) : null
    const automationArgs = buildAutomationArgs(state.config)
    return {
      ok: true,
      mode: openOptions.mode || 'connected',
      attachedTo: openOptions.attachedTo || undefined,
      appReady,
      path: page ? page.path : null,
      stable,
      stableTimeout: stableTimeout || undefined,
      toolInfo: runtimeProbe && runtimeProbe.toolInfo ? runtimeProbe.toolInfo : undefined,
      projectPath: state.config.projectPath,
      devtoolsProjectPath: automationArgs.devtoolsProjectPath || automationArgs.args[2],
      projectStrategy: automationArgs.projectStrategy,
      devtoolsProjectMap: state.config.devtoolsProjectMap || undefined,
      devtoolsProjectAutoLink: state.config.devtoolsProjectAutoLink || undefined,
      devtoolsProjectMirror: state.config.devtoolsProjectMirror || undefined,
      devtoolsPort: state.config.devtoolsPort,
      autoPort: state.config.autoPort,
      autoPortAssigned: Boolean(state.portResolution && state.portResolution.autoPortAssigned),
      runtimeAttached: Boolean(state.runtimeAttached),
      runtimeOwnerSession: state.runtimeOwnerSession || undefined,
    }
  }, {
    allowRuntimeNotReady: true,
    connectTimeoutMs: resolveOpenTimeoutMs(options),
    onProgress(phase) {
      if (phase === 'enable') {
        emitProgress('正在启动/连接 DevTools 自动化...', options)
        return
      }
      if (phase === 'connect') {
        emitProgress('正在等待小程序实例就绪...', options)
      }
    },
  })
}

function emitOpenResult(result, options) {
  const pathLabel = result.path || (result.appReady === false ? '(warming up)' : '(no page)')
  emit({
    message: `已连接 mode=${result.mode} path=${pathLabel} project=${result.projectPath} strategy=${result.projectStrategy} devtoolsProject=${result.devtoolsProjectPath} devtoolsPort=${result.devtoolsPort} autoPort=${result.autoPort}${result.attachedTo ? ` attachedTo=${result.attachedTo}` : ''}${result.autoPortAssigned ? ' (auto)' : ''}${result.appReady === false ? ' appReady=false' : ''}${result.stableTimeout ? ' stable=false' : ''}`,
    mode: result.mode,
    attachedTo: result.attachedTo,
    appReady: result.appReady,
    path: result.path,
    stable: result.stable || undefined,
    stableTimeout: result.stableTimeout || undefined,
    toolInfo: result.toolInfo || undefined,
    projectPath: result.projectPath,
    devtoolsProjectPath: result.devtoolsProjectPath,
    projectStrategy: result.projectStrategy,
    devtoolsProjectAutoLink: result.devtoolsProjectAutoLink,
    devtoolsProjectMirror: result.devtoolsProjectMirror,
    devtoolsPort: result.devtoolsPort,
    autoPort: result.autoPort,
    autoPortAssigned: result.autoPortAssigned,
    runtimeAttached: result.runtimeAttached,
    runtimeOwnerSession: result.runtimeOwnerSession,
  }, options)
}

async function resolveAttachableRuntime(state) {
  const sessions = await listSessionStates(createDefaultConfig())
  const projectPath = path.resolve(state.config.projectPath || '')
  const sameProjectSessions = []

  for (const session of sessions) {
    if (session.name === state.name) {
      continue
    }
    if (!session.autoPort || !session.projectPath || path.resolve(session.projectPath) !== projectPath) {
      continue
    }
    const live = await isAutomationEndpointLive({ ...state.config, autoPort: session.autoPort }, { timeoutMs: 1000 }).catch(() => false)
    sameProjectSessions.push({
      ...session,
      status: live ? 'live' : 'stale',
    })
  }

  const selected = selectAttachableRuntimeSession(sameProjectSessions)
  if (selected.mode !== 'attach') {
    return selected
  }

  const ownerConfig = await resolveSessionConfig(
    selected.session.name,
    mergeConfigOverrides(createDefaultConfig(), { projectPath: selected.session.projectPath }),
  )
  const ownerState = await loadSessionState(selected.session.name, ownerConfig)
  return {
    mode: 'attach',
    ownerState,
    session: selected.session,
  }
}

function summarizeDevtoolsStartupHints(logPayload) {
  const rules = [
    {
      code: 'appid-missing',
      pattern: /appid missing|41002/iu,
      message: 'DevTools 日志报告 appid missing / 41002；请确认 DevTools 实际打开的项目配置中 AppID 被正确读取。',
    },
    {
      code: 'app-launch-timeout',
      pattern: /routeTo appLaunch timeout|triggerAppRouteDone timeout/iu,
      message: 'DevTools 日志报告 appLaunch 超时；项目可能编译后没有进入可用 App runtime。',
    },
    {
      code: 'cli-server-start-error',
      pattern: /start cli server error/iu,
      message: 'DevTools 日志报告 cli server 启动失败；automation 端口可能没有成功监听。',
    },
    {
      code: 'windows-socket-10055',
      pattern: /tcp_socket_win\.cc.*10055|connect failed:\s*10055/iu,
      message: 'Windows socket 报 10055；通常表示本机网络/端口资源异常，可能影响 DevTools automation 端口启动。',
    },
  ]
  const files = ((logPayload && logPayload.files) || []).map((item) => ({
    path: String(item && item.path ? item.path : ''),
    lines: Array.isArray(item && item.lines) ? item.lines : [],
  }))

  const collectFileHints = (file, seen) => {
    const fileHints = []
    for (const line of file.lines || []) {
      const text = String(line || '').trim()
      if (!text) {
        continue
      }
      for (const rule of rules) {
        if (seen.has(rule.code) || !rule.pattern.test(text)) {
          continue
        }
        seen.add(rule.code)
        fileHints.push({
          code: rule.code,
          message: rule.message,
          sample: text,
        })
      }
    }
    return fileHints
  }

  const timestampedFiles = files.filter((file) => /(?:^|[\\/])logs[\\/].+\.log$/iu.test(file.path))
  const fallbackFiles = files.filter((file) => !timestampedFiles.includes(file))
  const groups = timestampedFiles.length ? [timestampedFiles] : [fallbackFiles]

  for (const group of groups) {
    const seen = new Set()
    for (const file of group) {
      const hints = collectFileHints(file, seen)
      if (hints.length) {
        return hints
      }
    }
  }

  return []
}

function resolveStartupIssueMessage(hints = [], code = '') {
  if (!code) {
    return ''
  }

  const normalizedCode = String(code)
  const match = (hints || []).find((item) => {
    if (!item || !item.code) {
      return false
    }
    if (normalizedCode === 'APP_LAUNCH_TIMEOUT') {
      return item.code === 'app-launch-timeout'
    }
    if (normalizedCode === 'WINDOWS_SOCKET_EXHAUSTED') {
      return item.code === 'windows-socket-10055'
    }
    if (normalizedCode === 'DEVTOOLS_AUTOMATION_SERVER_FAILED') {
      return item.code === 'cli-server-start-error'
    }
    if (normalizedCode === 'APPID_MISSING') {
      return item.code === 'appid-missing'
    }
    return false
  })

  return match && match.message ? String(match.message) : ''
}

function resolveStartupIssueRaw(hints = [], code = '', summaryLine = '') {
  const normalizedCode = String(code || '').trim()
  const normalizedSummaryLine = String(summaryLine || '').trim()
  const matchingHint = (hints || []).find((item) => {
    if (!item || !item.code) {
      return false
    }
    if (normalizedCode === 'APP_LAUNCH_TIMEOUT') {
      return item.code === 'app-launch-timeout'
    }
    if (normalizedCode === 'WINDOWS_SOCKET_EXHAUSTED') {
      return item.code === 'windows-socket-10055'
    }
    if (normalizedCode === 'DEVTOOLS_AUTOMATION_SERVER_FAILED') {
      return item.code === 'cli-server-start-error'
    }
    if (normalizedCode === 'APPID_MISSING') {
      return item.code === 'appid-missing'
    }
    return false
  })

  if (matchingHint && matchingHint.sample) {
    return String(matchingHint.sample)
  }
  return normalizedSummaryLine
}

function classifyOpenFailureFromStartupHints(hints = [], options: AnyRecord = {}) {
  const summaryLine = String(options.summaryLine || '').trim()
  if (/routeTo appLaunch timeout|triggerAppRouteDone timeout/iu.test(summaryLine)) {
    return {
      code: 'APP_LAUNCH_TIMEOUT',
      hint: 'devtoolsLog=app-launch-timeout',
    }
  }
  if (/tcp_socket_win\.cc.*10055|connect failed:\s*10055/iu.test(summaryLine)) {
    return {
      code: 'WINDOWS_SOCKET_EXHAUSTED',
      hint: 'devtoolsLog=windows-socket-10055',
    }
  }
  if (/start cli server error/iu.test(summaryLine)) {
    return {
      code: 'DEVTOOLS_AUTOMATION_SERVER_FAILED',
      hint: 'devtoolsLog=cli-server-start-error',
    }
  }
  if (/appid missing|41002/iu.test(summaryLine)) {
    return {
      code: 'APPID_MISSING',
      hint: 'devtoolsLog=appid-missing',
    }
  }

  const codes = new Set((hints || []).map((item) => item && item.code).filter(Boolean))
  if (codes.has('app-launch-timeout')) {
    return {
      code: 'APP_LAUNCH_TIMEOUT',
      hint: 'devtoolsLog=app-launch-timeout',
    }
  }
  if (codes.has('windows-socket-10055')) {
    return {
      code: 'WINDOWS_SOCKET_EXHAUSTED',
      hint: 'devtoolsLog=windows-socket-10055',
    }
  }
  if (codes.has('cli-server-start-error')) {
    return {
      code: 'DEVTOOLS_AUTOMATION_SERVER_FAILED',
      hint: 'devtoolsLog=cli-server-start-error',
    }
  }
  if (codes.has('appid-missing')) {
    return {
      code: 'APPID_MISSING',
      hint: 'devtoolsLog=appid-missing',
    }
  }
  return null
}

function compactStartupHints(hints = []) {
  return (hints || []).slice(0, 3).map((item) => ({
    code: item.code,
    sample: String(item.sample || '').slice(0, 240),
  }))
}

async function collectDevtoolsStartupHints(state) {
  try {
    const payload = await collectDevtoolsLogs(state.config, {
      limit: 220,
      files: 6,
      grep: 'appid missing|41002|routeTo appLaunch timeout|triggerAppRouteDone timeout|start cli server error|10055',
    })
    return summarizeDevtoolsStartupHints(payload)
  } catch (_) {
    return []
  }
}

async function collectDevtoolsLogContext(state, grep = '') {
  try {
    const payload = await collectDevtoolsLogs(state.config, {
      limit: 120,
      files: 4,
      grep,
    })
    return {
      log: extractLogSummary(payload),
    }
  } catch (_) {
    return { log: '' }
  }
}

function summarizeAutomationProbeHint(condition, probe) {
  if (!probe || !probe.connected) {
    return `phase=${condition.kind}; last=tool-connect`
  }

  const failingProbe = (probe.probes || []).find((item) => !item.ok)
  if (failingProbe) {
    if (failingProbe.timeout) {
      return `phase=${condition.kind}; last=${failingProbe.method} timeout`
    }
    return `phase=${condition.kind}; last=${failingProbe.method} error`
  }

  return `phase=${condition.kind}`
}

function summarizeOpenResolution(options, liveSameProjectSessions = []) {
  const liveCount = Array.isArray(liveSameProjectSessions) ? liveSameProjectSessions.length : 0
  if (liveCount > 1) {
    return 'ambiguous'
  }
  if (liveCount === 1) {
    if (options && options.autoPort) {
      return 'attach-blocked-by-auto-port'
    }
    return 'attachable'
  }
  if (options && options.devtoolsPort) {
    return 'adopt-via-devtools-port'
  }
  return 'start-required'
}

function resolveOpenFailureNextAction(options, liveSameProjectSessions = []) {
  const liveCount = Array.isArray(liveSameProjectSessions) ? liveSameProjectSessions.length : 0
  if (liveCount > 1) {
    return 'session list'
  }
  if (liveCount !== 1) {
    return ''
  }
  if (options && options.fresh) {
    return 'open without --fresh'
  }
  if (options && options.autoPort) {
    return 'open without --auto-port'
  }
  return ''
}

async function waitForAutomationCondition(state, condition, options) {
  const timeoutMs = resolveAwaitTimeoutMs(condition, options.timeout)
  const pollMs = Math.max(200, Number(options.pollMs || 500))
  const startedAt = Date.now()
  let lastProbe = null

  while (Date.now() - startedAt <= timeoutMs) {
    lastProbe = await probeAutomationRuntime(state.config, {
      timeoutMs: Number(options.probeTimeoutMs || Math.min(5000, pollMs * 4)),
    })

    if (condition.kind === 'tool-ready' && lastProbe.connected) {
      return {
        ok: true,
        condition: condition.raw,
        endpoint: lastProbe.endpoint,
        elapsedMs: Date.now() - startedAt,
      }
    }

    if (condition.kind === 'app-ready' && lastProbe.appReady) {
      return {
        ok: true,
        condition: condition.raw,
        endpoint: lastProbe.endpoint,
        elapsedMs: Date.now() - startedAt,
      }
    }

    await sleep(pollMs)
  }

  const logContext = await collectDevtoolsLogContext(state, 'error|fail|timeout|errcode|appid')
  const error = new Error(`await ${condition.raw} timed out after ${timeoutMs}ms`) as AnyRecord
  error.code = 'AWAIT_TIMEOUT'
  error.hint = summarizeAutomationProbeHint(condition, lastProbe)
  if (logContext.log) {
    error.log = logContext.log
    error.next = 'devtools logs'
  }
  throw error
}

function resolveExplicitAwaitCondition(rawValue, command, options, context: AnyRecord = {}) {
  if (options.noAwait) {
    return null
  }

  let raw = String(rawValue || '').trim()
  if (!raw) {
    return null
  }

  if (raw === 'auto') {
    if (command === 'goto' || command === 'relaunch') {
      raw = `route:${context.route || ''}`
    } else if (command === 'click' || command === 'tap' || command === 'native' || command === 'screenshot' || command === 'snapshot') {
      raw = 'route-settled'
    } else {
      raw = 'app-ready'
    }
  }

  return normalizeAwaitCondition(raw)
}

function attachStateToRuntime(state, ownerState) {
  const ownerConfig = ownerState.config || {}
  state.config = {
    ...state.config,
    autoPort: ownerConfig.autoPort || state.config.autoPort,
    devtoolsPort: ownerConfig.devtoolsPort || state.config.devtoolsPort,
    devtoolsProjectPath: ownerConfig.devtoolsProjectPath || state.config.devtoolsProjectPath,
    devtoolsProjectAutoLink: ownerConfig.devtoolsProjectAutoLink || undefined,
    devtoolsProjectMirror: ownerConfig.devtoolsProjectMirror || undefined,
  }
  state.runtimeAttached = true
  state.runtimeOwnerSession = ownerState.name
  state.runtimeAttachedAt = new Date().toISOString()
  state.portResolution = {
    autoPortAssigned: false,
    devtoolsPortAssigned: false,
  }
}

async function buildOpenFailureDiagnostics(state, options) {
  const automationArgs = buildAutomationArgs(state.config)
  const sessions = await listSessionStates(createDefaultConfig())
  const projectPath = path.resolve(state.config.projectPath || '')
  const liveSameProjectSessions = []
  const logContext = await collectDevtoolsLogContext(state, 'error|fail|timeout|errcode|appid')
  const startupHints = await collectDevtoolsStartupHints(state)
  const startupClassification = classifyOpenFailureFromStartupHints(startupHints, {
    summaryLine: logContext.log,
  })

  for (const session of sessions) {
    if (session.name === state.name) {
      continue
    }
    if (!session.autoPort || !session.projectPath || path.resolve(session.projectPath) !== projectPath) {
      continue
    }
    const live = await isAutomationEndpointLive({ ...state.config, autoPort: session.autoPort }, { timeoutMs: 1000 }).catch(() => false)
    if (live) {
      liveSameProjectSessions.push({
        name: session.name,
        autoPort: session.autoPort,
        devtoolsPort: session.devtoolsPort || '',
        route: session.route || '',
      })
    }
  }

  const diagnostics: AnyRecord = {
    projectPath: state.config.projectPath,
    devtoolsProjectPath: automationArgs.devtoolsProjectPath || automationArgs.args[2],
    projectStrategy: automationArgs.projectStrategy,
  }
  if (state.config.devtoolsPort) {
    diagnostics.devtoolsPort = state.config.devtoolsPort
  }
  if (state.config.autoPort) {
    diagnostics.autoPort = state.config.autoPort
  }
  if (liveSameProjectSessions.length) {
    diagnostics.liveSameProjectSessions = liveSameProjectSessions
  }
  if (startupHints.length) {
    diagnostics.startupHints = compactStartupHints(startupHints)
  }

  const resolution = summarizeOpenResolution(options, liveSameProjectSessions)
  const adoptBootstrap = resolution === 'adopt-via-devtools-port'
  if (adoptBootstrap) {
    diagnostics.devtoolsReuseMode = 'adopt-bootstrap'
  }

  const facts = [
    startupClassification ? startupClassification.hint : '',
    adoptBootstrap ? 'mode=adopt-bootstrap' : '',
    `resolution=${resolution}`,
    `strategy=${automationArgs.projectStrategy}`,
    state.config.autoPort ? `autoPort=${state.config.autoPort}` : '',
    `liveSameProjectSessions=${liveSameProjectSessions.length}`,
  ].filter(Boolean)

  return {
    diagnostics,
    code: startupClassification ? startupClassification.code : undefined,
    hint: facts.join('; '),
    log: logContext.log || undefined,
    next: resolveOpenFailureNextAction(options, liveSameProjectSessions) || undefined,
  }
}

async function handleDoctor(state, options) {
  const persistSession = Boolean(options.sessionProvided) && !options.ephemeralSession
  if (!persistSession && !(options.ephemeralSession && options.project && options.devtoolsPort)) {
    throw new Error('doctor 必须显式传 --session <name>。')
  }
  assertProjectPath(state.config)
  if (persistSession) {
    await saveSessionState(state)
  }

  let automationMetadata = null
  let automationError = null
  try {
    automationMetadata = enableAutomation(state.config)
  } catch (error) {
    automationError = {
      message: error && error.message ? String(error.message) : String(error),
      raw: error && error.raw ? String(error.raw) : undefined,
    }
  }

  const waitMs = Number(options.wait || 5000)
  if (!automationError && waitMs > 0) {
    await sleep(waitMs)
  }

  const probe = automationError
    ? null
    : await probeAutomationRuntime(state.config, {
      timeoutMs: Number(options.timeout || 5000),
      screenshot: Boolean(options.captureScreenshot),
    })

  const startupHints = (!automationError && probe && !probe.connected)
    ? await collectDevtoolsStartupHints(state)
    : []
  const doctorLogContext = (!automationError && probe && !probe.connected)
    ? await collectDevtoolsLogContext(state, 'error|fail|timeout|errcode|appid')
    : { log: '' }
  const startupClassification = (!automationError && probe && !probe.connected)
    ? classifyOpenFailureFromStartupHints(startupHints, {
      summaryLine: doctorLogContext.log,
    })
    : null
  const startupIssue = automationError
    ? null
    : (automationMetadata && automationMetadata.startupIssue)
      || (startupClassification
        ? {
          code: startupClassification.code,
          hint: startupClassification.hint,
          message: resolveStartupIssueMessage(startupHints, startupClassification.code),
          raw: resolveStartupIssueRaw(startupHints, startupClassification.code, doctorLogContext.log) || undefined,
        }
        : null)

  if (persistSession) {
    await saveSessionState(state)
  }

  const automationArgs = buildAutomationArgs(state.config)
  const payload = {
    ok: !automationError && Boolean(probe && probe.connected),
    projectPath: state.config.projectPath,
    devtoolsProjectPath: automationArgs.devtoolsProjectPath || automationArgs.args[2],
    projectStrategy: automationArgs.projectStrategy,
    devtoolsProjectAutoLink: state.config.devtoolsProjectAutoLink || undefined,
    devtoolsProjectMirror: state.config.devtoolsProjectMirror || undefined,
    devtoolsPort: state.config.devtoolsPort,
    autoPort: state.config.autoPort,
    automation: automationError
      ? { ok: false, error: automationError }
      : {
        ok: !startupIssue,
        ...automationMetadata,
        startupIssue: startupIssue || undefined,
        startupHints: startupHints.length ? compactStartupHints(startupHints) : undefined,
        log: doctorLogContext.log || undefined,
      },
    probe,
  }

  if (options.json) {
    emit(payload, options)
    return
  }

  const lines = [
    `project=${payload.projectPath}`,
    `devtoolsProject=${payload.devtoolsProjectPath}`,
    `projectStrategy=${payload.projectStrategy}`,
    `devtoolsPort=${payload.devtoolsPort || '-'} autoPort=${payload.autoPort || '-'}`,
  ]
  if (automationError) {
    lines.push(`automation=failed ${automationError.message}`)
  } else {
    lines.push(`automation=${payload.automation.ok ? 'ok' : 'failed'}`)
    if (payload.automation.startupIssue && payload.automation.startupIssue.code) {
      lines.push(`startupIssue=${payload.automation.startupIssue.code}`)
    }
  }
  if (probe) {
    lines.push(`websocket=${probe.connected ? 'ok' : 'failed'}`)
    lines.push(`appRuntime=${probe.appReady ? 'ok' : 'not-ready'}`)
    if (probe.toolInfo) {
      lines.push(`toolInfo=${JSON.stringify(probe.toolInfo)}`)
    }
    for (const item of probe.probes || []) {
      lines.push(`${item.method}=${item.ok ? 'ok' : item.timeout ? 'timeout' : `error ${item.error}`}`)
    }
    lines.push(`diagnosis=${probe.diagnosis}`)
  }
  emit({ lines }, options)
}

function parseJsonArgument(rawValue, fallback) {
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return fallback
  }
  try {
    return JSON.parse(String(rawValue))
  } catch (error) {
    throw new Error(`Invalid JSON argument: ${rawValue}`)
  }
}

async function handleProtocol(state, method, rawParams, options) {
  if (!method) {
    throw new Error('protocol requires a method, e.g. protocol Tool.getInfo')
  }
  if (!options.sessionProvided) {
    throw new Error('protocol 必须显式传 --session <name>。')
  }
  assertProjectPath(state.config)
  await saveSessionState(state)
  const params = parseJsonArgument(rawParams, {})
  const result = await sendAutomationProtocol(state.config, method, params, {
    timeoutMs: Number(options.timeout || 5000),
  })
  await saveSessionState(state)
  emit({
    ...result,
    automation: {
      mode: 'connect-only',
      note: 'protocol does not start or refresh DevTools; run open/doctor when the session is stale.',
    },
  }, options)
}

async function handleDevtools(state, rest, options) {
  const subcommand = rest[0]
  if (subcommand !== 'logs') {
    throw new Error(`Unknown devtools command: ${subcommand || '(empty)'}`)
  }

  const payload = await collectDevtoolsLogs(state.config, {
    limit: options.limit,
    files: options.files,
    grep: options.grep,
  })

  if (options.json) {
    emit(payload, options)
    return
  }

  const lines = [
    `logRoot=${payload.logRoot}`,
    `productHash=${payload.productHash}`,
  ]
  for (const file of payload.files) {
    lines.push(`== ${file.path} ==`)
    lines.push(...file.lines)
  }
  emit({ lines }, options)
}

async function handleSessionList(options) {
  const baseConfig = mergeConfigOverrides(createDefaultConfig(), buildExplicitOverrides(options))
  const sessions = await listSessionStates(baseConfig)
  let projectFilter = ''
  let message = ''
  if (!options.all) {
    if (options.project) {
      projectFilter = resolveMiniProgramProjectInfo(options.project).projectPath
    } else {
      const currentProject = discoverMiniProgramProjectFromCwd(process.cwd())
      projectFilter = currentProject ? currentProject.projectPath : ''
    }
    if (!projectFilter) {
      message = '当前目录没有发现小程序项目；默认不显示全局 session。可传 --project <path> 或 --all 查看。'
    }
  }
  const visibleSessions = projectFilter
    ? sessions.filter((item) => path.resolve(item.projectPath || '') === projectFilter)
    : (options.all ? sessions : [])
  const sessionsWithStatus = await Promise.all(visibleSessions.map(async (item) => {
    const live = item.autoPort
      ? await isAutomationEndpointLive({ ...baseConfig, autoPort: item.autoPort }, { timeoutMs: 800 }).catch(() => false)
      : false
    return {
      ...item,
      status: live ? 'live' : 'stale',
    }
  }))

  if (options.json) {
    emit({
      sessions: sessionsWithStatus,
      ...(message ? { message } : {}),
    }, options)
    return
  }

  if (!sessionsWithStatus.length) {
    emit({ message: message || '当前没有已保存的 session' }, options)
    return
  }

  emit({
    lines: sessionsWithStatus.map((item) => {
      const project = item.projectPath || '(unbound)'
      const devtoolsProject = item.devtoolsProjectPath ? ` devtoolsProject=${item.devtoolsProjectPath}` : ''
      const route = item.route || '(no route)'
      return `${item.name} status=${item.status} project=${project}${devtoolsProject} devtoolsPort=${item.devtoolsPort || '-'} autoPort=${item.autoPort || '-'} route=${route}`
    }),
  }, options)
}

async function shutdownOwnedRuntime(state) {
  const result: AnyRecord = {
    runtimeShutdown: true,
    automationClosed: false,
    projectClosed: false,
    closeAttempted: false,
  }

  await withMiniProgram(state, async (miniProgram) => {
    await shutdownMiniProgram(miniProgram)
    result.automationClosed = true
  }).catch((error) => {
    result.automationError = error && error.message ? String(error.message) : String(error)
  })

  const closeResult = closeDevtoolsProject(state.config, { timeoutMs: 30000 })
  result.projectClosed = Boolean(closeResult && closeResult.ok)
  result.closeVerified = false
  result.closeAttempted = Boolean(closeResult && closeResult.attempted)
  if (closeResult && closeResult.reason) {
    result.reason = closeResult.reason
  }
  if (closeResult && closeResult.error) {
    result.closeError = closeResult.error
  }
  if (closeResult && closeResult.projectPath) {
    result.devtoolsProjectPath = closeResult.projectPath
  }

  if (state.runtimeLaunchId && (closeResult && closeResult.ok)) {
    await removeRuntimeLaunch(state.runtimeLaunchId, state.config).catch(() => false)
  }
  return result
}

async function handleSessionPrune(options) {
  if (options.all) {
    throw new Error('session prune 不支持全局清理；请在小程序项目目录执行，或显式传 --project <miniprogram-root>。')
  }

  const baseConfig = mergeConfigOverrides(createDefaultConfig(), buildExplicitOverrides(options))
  const projectFilter = options.project
    ? resolveMiniProgramProjectInfo(options.project).projectPath
    : (discoverMiniProgramProjectFromCwd(process.cwd()) || {}).projectPath
  if (!projectFilter) {
    throw new Error('session prune 需要当前目录能发现小程序项目，或显式传 --project <miniprogram-root>。')
  }

  const sessions = await listSessionStates(baseConfig)
  const visibleSessions = sessions.filter((item) => path.resolve(item.projectPath || '') === projectFilter)
  const sessionsWithStatus = await Promise.all(visibleSessions.map(async (item) => {
    const live = item.autoPort
      ? await isAutomationEndpointLive({ ...baseConfig, autoPort: item.autoPort }, { timeoutMs: 800 }).catch(() => false)
      : false
    return {
      ...item,
      status: live ? 'live' : 'stale',
    }
  }))

  const pruned: AnyRecord[] = []
  const launchesPruned: AnyRecord[] = []
  const failed: AnyRecord[] = []
  const skipped: AnyRecord[] = sessionsWithStatus
    .filter((item) => item.status === 'live')
    .map((item) => ({ name: item.name, status: item.status, autoPort: item.autoPort || '' }))

  for (const session of sessionsWithStatus.filter((item) => item.status === 'stale')) {
    const targetConfig = await resolveSessionConfig(
      session.name,
      mergeConfigOverrides(baseConfig, { projectPath: session.projectPath }),
    )
    const lock = await acquireSessionLock(session.name, targetConfig, { command: 'session prune' })
    try {
      const targetState = await loadSessionState(session.name, targetConfig)
      const closeResult = closeDevtoolsProject(targetState.config, { timeoutMs: 30000 })
      await waitAfterDevtoolsCloseRequest(closeResult)
      const canClearSession = shouldClearFailedOpenSession(closeResult)
        && (Boolean(closeResult && closeResult.ok)
          || !Boolean(closeResult && closeResult.attempted)
          || session.status === 'stale')
      const summary = {
        name: session.name,
        status: session.status,
        autoPort: session.autoPort || '',
        projectClosed: Boolean(closeResult && closeResult.ok),
        closeVerified: false,
        closeAttempted: Boolean(closeResult && closeResult.attempted),
      } as AnyRecord

      if (closeResult && closeResult.reason) {
        summary.reason = closeResult.reason
      }
      if (closeResult && closeResult.error) {
        summary.error = closeResult.error
      }
      if (canClearSession) {
        await clearSessionState(session.name, targetState.config)
        summary.sessionCleared = true
        pruned.push(summary)
      } else {
        summary.sessionCleared = false
        failed.push(summary)
      }
    } finally {
      await releaseSessionLock(lock)
    }
  }

  const launches = await listRuntimeLaunches({ ...baseConfig, projectPath: projectFilter })
  for (const launch of launches) {
    const live = launch.autoPort
      ? await isAutomationEndpointLive({ ...baseConfig, autoPort: launch.autoPort }, { timeoutMs: 800 }).catch(() => false)
      : false
    if (live) {
      skipped.push({
        id: launch.id,
        sessionName: launch.sessionName || '',
        status: 'live',
        autoPort: launch.autoPort || '',
      })
      continue
    }

    const targetConfig = mergeConfigOverrides(baseConfig, {
      projectPath: launch.projectPath,
      cliPath: launch.cliPath,
      autoPort: launch.autoPort,
      devtoolsPort: launch.devtoolsPort,
      devtoolsProjectPath: launch.devtoolsProjectPath,
    })
    const closeResult = closeDevtoolsProject(targetConfig, { timeoutMs: 30000 })
    await waitAfterDevtoolsCloseRequest(closeResult)
    const canClearLaunch = shouldClearFailedOpenSession(closeResult)
    const summary = {
      id: launch.id,
      sessionName: launch.sessionName || '',
      autoPort: launch.autoPort || '',
      projectClosed: Boolean(closeResult && closeResult.ok),
      closeVerified: false,
      closeAttempted: Boolean(closeResult && closeResult.attempted),
    } as AnyRecord

    if (closeResult && closeResult.reason) {
      summary.reason = closeResult.reason
    }
    if (closeResult && closeResult.error) {
      summary.error = closeResult.error
    }
    if (canClearLaunch || !summary.closeAttempted) {
      await removeRuntimeLaunch(launch.id, targetConfig)
      summary.launchCleared = true
      launchesPruned.push(summary)
    } else {
      summary.launchCleared = false
      failed.push(summary)
    }
  }

  if (failed.length) {
    const error = new Error(`session prune failed for ${failed.length} item(s)`) as AnyRecord
    error.code = 'SESSION_PRUNE_FAILED'
    error.diagnostics = { projectPath: projectFilter, pruned, launchesPruned, failed, skipped }
    throw error
  }

  emit({
    message: `已清理 ${pruned.length} 个 stale session、${launchesPruned.length} 个 orphan launch${skipped.length ? `，保留 ${skipped.length} 个 live runtime` : ''}`,
    projectPath: projectFilter,
    pruned,
    launchesPruned,
    skipped,
  }, options)
}

async function handlePath(state, options) {
  const pathValue = await withMiniProgram(state, async (miniProgram) => {
    const page = await getCurrentPage(miniProgram)
    state.route = page.path
    return page.path
  })

  await saveSessionState(state)
  emit({ message: pathValue, path: pathValue }, options)
}

function isTabBarRoute(route, runtimeConfig) {
  const normalizedRoute = normalizeRoutePath(route)
  const list = runtimeConfig && runtimeConfig.tabBar && Array.isArray(runtimeConfig.tabBar.list)
    ? runtimeConfig.tabBar.list
    : []
  return list.some((item) => normalizeRoutePath(item && (item.pagePath || item.path)) === normalizedRoute)
}

async function handleRelaunch(state, route, options) {
  if (!route) {
    throw new Error('goto/relaunch requires a route, e.g. goto /pages/index/index')
  }
  const waitMs = Number(options.wait || 1500)
  const targetPath = normalizeRoutePath(route)
  const awaitCondition = resolveExplicitAwaitCondition(options.await, 'goto', options, { route: targetPath })
  const payload = await withMiniProgram(state, async (miniProgram) => {
    const pageBefore = await getCurrentPage(miniProgram).catch(() => null)
    const pathBefore = pageBefore && pageBefore.path ? pageBefore.path : state.route || ''
    const runtimeConfig = await getRuntimeAppConfig(miniProgram).catch(() => ({ tabBar: { list: [] } }))
    const method = isTabBarRoute(route, runtimeConfig) && typeof miniProgram.switchTab === 'function'
      ? 'switchTab'
      : 'reLaunch'

    if (method === 'switchTab') {
      await miniProgram.switchTab(route)
    } else {
      await miniProgram.reLaunch(route)
    }
    await sleep(waitMs)
    const routeResult = awaitCondition
      ? await waitForMiniProgramCondition(miniProgram, state, awaitCondition, {
        timeout: options.timeout,
        pathBefore,
      }).then((result) => ({
        path: result.path,
        routeEvents: [],
        expectedPath: targetPath,
        expectedMatched: true,
      }))
      : await confirmRouteAfterAction(miniProgram, state, {
        pathBefore,
        expectedPath: targetPath,
        expectedStableMatches: 2,
        timeoutMs: Math.max(waitMs, 3000),
        pollMs: 200,
      })

    if (!routeResult.expectedMatched) {
      const actual = routeResult.path || pathBefore || '(unknown)'
      throw new Error(`goto failed: expected ${targetPath}, but current page is ${actual}. If the target is a tabBar page, DevTools may have rejected the route; check page-stack/timeline/devtools logs.`)
    }

    state.route = routeResult.path
    return {
      message: routeResult.path,
      path: routeResult.path,
      method,
    }
  })

  markPendingVisualAction(state, 'goto', payload.path)
  await saveSessionState(state)
  emit(payload, options)
}

async function handleSnapshot(state, options, scopeRef = null) {
  const awaitCondition = resolveExplicitAwaitCondition(options.await, 'snapshot', options)
  const payload = await withMiniProgram(state, async (miniProgram) => {
    if (awaitCondition) {
      await waitForMiniProgramCondition(miniProgram, state, awaitCondition, {
        timeout: options.timeout,
        scopeRef,
      })
    }
    const page = await getCurrentPage(miniProgram)
    const result = await snapshotInteractive(page, state, scopeRef, {
      compact: Boolean(options.compact),
      depth: options.depth === undefined ? undefined : Number(options.depth),
    })
    Object.assign(state, result.state)
    let records = result.records
    let lines = result.lines

    const wantMap = !Boolean(options.noMap)
    if (options.layout || wantMap) {
      const systemInfo = await miniProgram.systemInfo()
      const rects = await collectRecordRects(page, records, systemInfo)
      records = mergeRecordLayouts(records, rects)
      if (options.layout) {
        lines = formatSnapshotLines(records, { layout: true })
      }
      if (wantMap) {
        const viewport = {
          w: Number(systemInfo.windowWidth) || Number(systemInfo.screenWidth) || 375,
          h: Number(systemInfo.windowHeight) || Number(systemInfo.screenHeight) || 812,
        }
        const map = renderAsciiMap(records, { viewport })
        if (map) {
          lines = lines.concat(map)
        }
      }
    }

    let visual = null
    if (options.visual && shouldAttemptVisualProbe(state, page.path, scopeRef, options)) {
      const visualProbePath = path.join(state.config.tempScreenshotDir, `visual-probe-${Date.now()}-${Math.random().toString(16).slice(2)}.png`)
      const currentProbe = await captureVisualProbeForSnapshot(miniProgram, page, state, records, visualProbePath)
      visual = maybeBuildImplicitVisualChange(state, currentProbe)
    }

    return {
      ...result,
      records,
      lines,
      visual,
    }
  })

  await saveSessionState(state)
  emit(summarizeSnapshotPayload(payload, options), options)
}

async function handleQuery(state, mode, value, options, scopeRef = null) {
  const payload = await withMiniProgram(state, async (miniProgram) => {
    const page = await getCurrentPage(miniProgram)
    const result = await queryRecords(page, state, mode, value, scopeRef)
    Object.assign(state, result.state)
    return result
  })

  await saveSessionState(state)
  emit(payload, options)
}

async function handleTap(state, target, options, scopeRef = null) {
  const waitMs = Number(options.wait || 1200)
  const awaitCondition = resolveExplicitAwaitCondition(options.await, 'click', options)
  const payload = await withMiniProgram(state, async (miniProgram) => {
    const page = await getCurrentPage(miniProgram)
    const pathBefore = page.path
    const element = await resolveTarget(page, state, target, scopeRef)
    await element.tap()
    await sleep(waitMs)
    const routeResult = awaitCondition
      ? await waitForMiniProgramCondition(miniProgram, state, awaitCondition, {
        timeout: options.timeout,
        pathBefore,
        scopeRef,
      }).then(async (result) => ({
        path: result.path,
        routeEvents: (await syncRouteTimelineEvents(miniProgram, state)).events,
      }))
      : await confirmRouteAfterAction(miniProgram, state, {
        pathBefore,
        timeoutMs: waitMs,
      })
    return {
      message: `已点击 ${target}`,
      path: routeResult.path,
      notices: buildClickNotices({
        pathBefore,
        pathAfter: routeResult.path,
        routeEvents: routeResult.routeEvents,
      }),
    }
  })

  markPendingVisualAction(state, 'click', payload.path)
  await saveSessionState(state)
  emit(payload, options)
}

async function handleInput(state, target, value, options, scopeRef = null) {
  const waitMs = Number(options.wait || 500)
  const payload = await withMiniProgram(state, async (miniProgram) => {
    const page = await getCurrentPage(miniProgram)
    const pathBefore = page.path
    const element = await resolveTarget(page, state, target, scopeRef)
    await element.input(value)
    await sleep(waitMs)
    return { message: `已输入 ${target}`, path: pathBefore }
  })

  markPendingVisualAction(state, 'fill', payload.path)
  await saveSessionState(state)
  emit(payload, options)
}

async function handleAwaitCommand(state, rawCondition, options, scopeRef = null) {
  if (!options.sessionProvided) {
    throw new Error('await 必须显式传 --session <name>。')
  }
  assertProjectPath(state.config)
  const condition = normalizeAwaitCondition(rawCondition)

  if (condition.kind === 'tool-ready' || condition.kind === 'app-ready') {
    const payload = await waitForAutomationCondition(state, condition, options)
    await saveSessionState(state)
    emit({
      message: `await completed ${condition.raw}`,
      ...payload,
    }, options)
    return
  }

  const payload = await withMiniProgram(state, async (miniProgram) => {
    return await waitForMiniProgramCondition(miniProgram, state, condition, {
      timeout: options.timeout,
      wait: options.wait,
      scopeRef,
    })
  })

  await saveSessionState(state)
  emit({
    message: `await completed ${condition.raw}`,
    ...payload,
  }, options)
}

async function handleWait(state, target, options, scopeRef = null) {
  const timeoutMs = Number(options.wait || 10000)

  await withMiniProgram(state, async (miniProgram) => {
    const page = await getCurrentPage(miniProgram)
    if (/^\d+$/u.test(target)) {
      await sleep(Number(target))
      return
    }

    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      try {
        if (isRefToken(target)) {
          await resolveTarget(page, state, target, scopeRef)
          return
        }

        const scope = scopeRef ? await resolveTarget(page, state, scopeRef) : page
        const matches = await scope.$$(target)
        if (matches.length > 0) {
          return
        }
      } catch (_) {
      }

      await sleep(200)
    }

    const error = new Error(`wait timeout: ${target}`) as AnyRecord
    error.code = 'WAIT_TIMEOUT'
    error.hint = `target=${target}`
    throw error
  })

  await saveSessionState(state)
  emit({ message: `等待完成 ${target}` }, options)
}

async function handleGet(state, what, target, detail, options, scopeRef = null) {
  const payload = await withMiniProgram(state, async (miniProgram) => {
    const page = await getCurrentPage(miniProgram)

    switch (what) {
      case 'path':
        return { message: page.path, path: page.path }
      case 'data':
        return { data: target ? await page.data(target) : await page.data() }
      case 'count': {
        if (!target) {
          throw new Error('get count requires a selector or ref')
        }
        if (isRefToken(target)) {
          await resolveTarget(page, state, target, scopeRef)
          return { count: 1 }
        }
        const scope = scopeRef ? await resolveTarget(page, state, scopeRef) : page
        const matches = await scope.$$(target)
        return { count: matches.length }
      }
      case 'text': {
        const element = await resolveTarget(page, state, target, scopeRef)
        return { text: await element.text() }
      }
      case 'value': {
        const element = await resolveTarget(page, state, target, scopeRef)
        return { value: await element.value() }
      }
      case 'attr': {
        const element = await resolveTarget(page, state, target, scopeRef)
        return { value: await getElementAttribute(element, detail) }
      }
      case 'prop': {
        const element = await resolveTarget(page, state, target, scopeRef)
        return { value: await getElementProperty(element, detail) }
      }
      case 'rect': {
        const element = await resolveTarget(page, state, target, scopeRef)
        return { rect: await getElementRect(element) }
      }
      default:
        throw new Error(`Unknown get target: ${what}`)
    }
  })

  await saveSessionState(state)
  emit(payload, options)
}

async function handleEval(state, source, options) {
  const script = options.stdin ? await readStdin() : source
  const payload = await withMiniProgram(state, async (miniProgram) => {
    const result = await evaluateInMiniProgram(miniProgram, script)
    return {
      result,
      message: options.json ? undefined : JSON.stringify(result, null, 2),
    }
  })

  await saveSessionState(state)
  emit(payload, options)
}

async function handleNative(state, method, args, options) {
  const waitMs = Number(options.wait || 800)
  const awaitCondition = resolveExplicitAwaitCondition(options.await, 'native', options)
  const payload = await withMiniProgram(state, async (miniProgram) => {
    const page = await getCurrentPage(miniProgram)
    const pathBefore = page.path
    const result = await callNativeMethod(miniProgram, method, args)
    if (waitMs > 0) {
      await sleep(waitMs)
    }
    const routeResult = awaitCondition
      ? await waitForMiniProgramCondition(miniProgram, state, awaitCondition, {
        timeout: options.timeout,
        pathBefore,
      }).then(async (awaitResult) => ({
        path: awaitResult.path,
        routeEvents: (await syncRouteTimelineEvents(miniProgram, state)).events,
      }))
      : await confirmRouteAfterAction(miniProgram, state, {
        pathBefore,
        timeoutMs: waitMs,
      })
    const diagnostic = buildNativeDiagnostic(method, result, {
      pathBefore,
      pathAfter: routeResult.path || pathBefore,
      routeEvents: routeResult.routeEvents,
    })
    if (!options.json && !diagnostic.error && !diagnostic.message) {
      diagnostic.message = JSON.stringify(result, null, 2)
    }
    return diagnostic
  })

  markPendingVisualAction(state, `native:${method}`, payload.path)
  await saveSessionState(state)
  emit(payload, options)
}

async function handleSystemInfo(state, options) {
  const payload = await withMiniProgram(state, async (miniProgram) => {
    const systemInfo = await getSystemInfo(miniProgram)
    return {
      systemInfo,
      message: options.json ? undefined : JSON.stringify(systemInfo, null, 2),
    }
  })

  await saveSessionState(state)
  emit(payload, options)
}

async function handlePageStack(state, options) {
  const payload = await withMiniProgram(state, async (miniProgram) => {
    const pages = await getPageStack(miniProgram)
    return {
      pages,
      lines: pages.map((item, index) => `${index + 1}. ${item.path}`),
    }
  })

  await saveSessionState(state)
  emit(payload, options)
}

function buildObservedEdges(routeEvents) {
  return (routeEvents || []).map((event) => ({
    from: event.from,
    to: event.to,
    method: event.openType,
  }))
}

async function handleAppInspect(state, options) {
  assertProjectPath(state.config)
  const sections = normalizeInspectSections(options)
  const recentRoutes = getStoredRouteTimeline(state, { limit: 10 })
  const observedEdges = buildObservedEdges(state.routeEvents)
  let runtimeConfig = {}
  let current = state.route || null
  let pageStack = []
  let runtimeWarning = null

  if (state.bound) {
    try {
      const live = await withMiniProgram(state, async (miniProgram) => {
        const [nextRuntimeConfig, nextPageStack] = await Promise.all([
          getRuntimeAppConfig(miniProgram).catch(() => ({})),
          getPageStack(miniProgram).catch(() => []),
        ])
        const currentPage = await getCurrentPage(miniProgram).catch(() => null)
        return {
          runtimeConfig: nextRuntimeConfig,
          pageStack: nextPageStack,
          current: currentPage && currentPage.path ? currentPage.path : '',
        }
      })
      runtimeConfig = live.runtimeConfig || {}
      pageStack = Array.isArray(live.pageStack) ? live.pageStack : []
      current = live.current || (pageStack.length ? pageStack[pageStack.length - 1].path : current)
    } catch (error) {
      runtimeWarning = `runtime inspect skipped: ${error && error.message ? error.message : error}`
    }
  }

  const result = await inspectProjectStructure({
    projectPath: state.config.projectPath,
    runtimeConfig,
    current,
    pageStack,
    recentRoutes,
    observedEdges,
    sections,
  })
  const payload = {
    ...result,
    warnings: runtimeWarning ? [runtimeWarning] : undefined,
    lines: formatInspectLines(result),
  }
  if (runtimeWarning) {
    payload.lines.push(runtimeWarning)
  }

  await saveSessionState(state)
  emit(payload, options)
}

async function handleTimeline(state, action, options) {
  if (action === 'clear') {
    clearStoredRouteTimeline(state)
    await saveSessionState(state)
    emit({ message: '已清空 timeline' }, options)
    return
  }

  const payload = await withMiniProgram(state, async (miniProgram) => {
    await syncRouteTimelineEvents(miniProgram, state)
    const events = getStoredRouteTimeline(state, { limit: options.limit })
    return {
      events,
      lines: events.map(formatRouteTimelineLine),
      message: events.length ? undefined : '当前没有 route timeline',
    }
  })

  await saveSessionState(state)
  emit(summarizeTimelinePayload(payload, options), options)
}

async function handleLogs(state, kind, action, options) {
  if (!state.bound) {
    throw new Error(`Session not found: ${state.name}. Run miniprogram-browser open --session ${state.name} --project <miniprogram-root> first.`)
  }

  if (action === 'clear') {
    clearStoredRuntimeEvents(state, kind)
    await saveSessionState(state)
    emit({ message: kind === 'exception' ? '已清空 exceptions' : '已清空 logs' }, options)
    return
  }

  const waitMs = Number(options.wait || 0)
  if (waitMs > 0) {
    await withMiniProgram(state, async () => {
      await sleep(waitMs)
    })
    await saveSessionState(state)
  }

  const events = getStoredRuntimeEvents(state, kind, { limit: options.limit })
  const lines = formatRuntimeEventLines(
    events,
    kind === 'exception' ? formatExceptionEventLine : formatConsoleEventLine,
  )
  emit({
    events,
    lines,
    message: lines.length ? undefined : (kind === 'exception' ? '当前没有 exception' : '当前没有 console 输出'),
  }, options)
}

async function syncRouteTimelinePrelude(state, options, command) {
  if (!shouldEmitPreludeNotices(command)) {
    return
  }

  if (command === 'open' || command === 'connect' || command === 'close' || command === 'app' || command === 'doctor' || command === 'protocol' || command === 'devtools') {
    return
  }

  if (!state.config || !String(state.config.projectPath || '').trim()) {
    return
  }

  const payload = await withMiniProgram(state, async (miniProgram) => {
    return syncRouteTimelineEvents(miniProgram, state)
  })

  if (payload.events.length) {
    await saveSessionState(state)
  }

  if (payload.events.length) {
    options._notices = [
      `自上次命令后路由变化 ${payload.events.length} 次`,
      ...payload.events.map(formatRouteTimelineLine),
    ]
  }
}

async function handleCall(state, target, method, args, options) {
  if (!target || !method) {
    throw new Error('call requires target and method, e.g. call wx getSystemInfoSync')
  }

  const payload = await withMiniProgram(state, async (miniProgram) => {
    const page = target === 'page' ? await getCurrentPage(miniProgram) : null
    if (target === 'wx') {
      const result = await callWxMethod(miniProgram, method, args)
      return { result, path: state.route || '', message: options.json ? undefined : JSON.stringify(result, null, 2) }
    }

    if (target === 'page') {
      const result = await callPageMethod(page, method, args)
      return { result, path: page.path, message: options.json ? undefined : JSON.stringify(result, null, 2) }
    }

    throw new Error(`Unsupported call target: ${target}`)
  })

  if (target === 'wx' || target === 'page') {
    markPendingVisualAction(state, `call:${target}:${method}`, payload.path)
  }
  await saveSessionState(state)
  emit(payload, options)
}

async function handleScreenshot(state, outputPath, options) {
  const awaitCondition = resolveExplicitAwaitCondition(options.await, 'screenshot', options)
  const payload = await withMiniProgram(state, async (miniProgram) => {
    if (awaitCondition) {
      await waitForMiniProgramCondition(miniProgram, state, awaitCondition, {
        timeout: options.timeout,
      })
    }
    const mode = options.mode || 'layout'
    const focusRefs = parseFocusRefs(options.focus)
    const timeoutMs = Number(options.wait || 30000)
    const name = outputPath
      ? path.isAbsolute(outputPath)
        ? outputPath
        : path.join(process.cwd(), outputPath)
      : path.join(state.config.tempScreenshotDir, `shot-${Date.now()}.png`)

    async function resolveRefs() {
      const page = await getCurrentPage(miniProgram)
      const snapshot = await snapshotInteractive(page, state, null, { compact: true })
      Object.assign(state, snapshot.state)
      return collectRecordRects(page, snapshot.records, await miniProgram.systemInfo())
    }

    if (mode === 'visual') {
      const result = await captureVisualScreenshot({
        miniProgram,
        targetPath: name,
        config: state.config,
        timeoutMs,
        pageCapture: async (targetPath, timeoutMs) => {
          return captureScreenshotToPath(miniProgram, targetPath, timeoutMs)
        },
      })

      let focusLegend
      let source = result.source
      if (focusRefs.length) {
        const focus = await overlayFocusScreenshot({
          targetPath: name,
          config: state.config,
          refs: await resolveRefs(),
          focusRefs,
          noRef: Boolean(options.noRef),
        })
        focusLegend = focus.focusLegend
        source = `${source}+focus`
      }

      return {
        message: `截图已保存 ${result.path} mode=${result.mode} source=${source}`,
        path: result.path,
        mode: result.mode,
        source,
        focusLegend,
      }
    }

    if (mode === 'annotate') {
      const page = await getCurrentPage(miniProgram)
      await captureScreenshotToPath(miniProgram, name, timeoutMs)
      const snapshot = await snapshotInteractive(page, state, null, { compact: true })
      Object.assign(state, snapshot.state)
      const refs = await collectRecordRects(page, snapshot.records, await miniProgram.systemInfo())
      const result = await captureAnnotatedScreenshot({
        miniProgram,
        targetPath: name,
        config: state.config,
        refs,
        focusRefs,
        noRef: Boolean(options.noRef),
        timeoutMs,
        pageCapture: async (targetPath) => targetPath,
      })

      return {
        message: `截图已保存 ${result.path} mode=${result.mode} source=${result.source}`,
        path: result.path,
        mode: result.mode,
        source: result.source,
        legend: result.legend,
        focusLegend: result.focusLegend,
      }
    }

    if (mode === 'layout') {
      const page = await getCurrentPage(miniProgram)
      const systemInfo = await miniProgram.systemInfo()
      const snapshot = await snapshotInteractive(page, state, null, { compact: Boolean(options.compact) })
      Object.assign(state, snapshot.state)
      const semanticRecords = mergeRecordLayouts(snapshot.records, await collectRecordRects(page, snapshot.records, systemInfo))
      let refs = semanticRecords
      if (options.raw) {
        const rawTree = await readRuntimeTree(page, { raw: true })
        const rawRecords = flattenRuntimeNodes(rawTree ? rawTree.nodes : [])
        refs = mergeRecordLayouts(rawRecords, await collectRecordRects(page, rawRecords, systemInfo))
      }
      const menuButtonRect = options.capsule
        ? await readOfficialMenuButtonRect(miniProgram, 800)
        : undefined
      const result = await captureLayoutScreenshot({
        targetPath: name,
        config: state.config,
        refs,
        badgeRecords: semanticRecords,
        focusRecords: semanticRecords,
        focusRefs,
        noRef: Boolean(options.noRef),
        systemInfo,
        menuButtonRect,
        capsule: Boolean(options.capsule),
      })

      return {
        message: `截图已保存 ${result.path} mode=${result.mode} source=${result.source}`,
        path: result.path,
        mode: result.mode,
        source: result.source,
        focusLegend: result.focusLegend,
      }
    }

    const screenshotPath = await captureScreenshotToPath(miniProgram, name, timeoutMs)
    let source = 'page'
    let focusLegend

    if (focusRefs.length) {
      const focus = await overlayFocusScreenshot({
        targetPath: screenshotPath,
        config: state.config,
        refs: await resolveRefs(),
        focusRefs,
        noRef: Boolean(options.noRef),
      })
      focusLegend = focus.focusLegend
      source = 'page+focus'
    }

    return {
      message: `截图已保存 ${screenshotPath} mode=page source=${source}`,
      path: screenshotPath,
      mode: 'page',
      source,
      focusLegend,
    }
  })

  await saveSessionState(state)
  emit(payload, options)
}

async function handleClose(state, options) {
  const baseConfig = createDefaultConfig()
  const resolvedConfig = options.project
    ? mergeConfigOverrides(baseConfig, { projectPath: options.project })
    : baseConfig
  state = await loadSessionState(state.name, resolvedConfig)
  const shutdownRuntime = shouldShutdownRuntimeOnClose(state, options)
  let cleanup: AnyRecord = { runtimeShutdown: false }
  if (shutdownRuntime) {
    cleanup = await shutdownOwnedRuntime(state)
  }
  await clearSessionState(state.name, state.config)
  emit({
    message: shutdownRuntime
      ? `已关闭 session ${state.name}`
      : `已解绑 session ${state.name}，保留 owner runtime ${state.runtimeOwnerSession || '(unknown)'}`,
    runtimeShutdown: shutdownRuntime,
    runtimeOwnerSession: state.runtimeOwnerSession || undefined,
    cleanup,
  }, options)
}

async function dispatch(state, positional, options, context: AnyRecord = {}) {
  const [command, ...rest] = positional

  switch (command) {
    case undefined:
    case 'help':
      printHelp()
      return
    case 'open':
    case 'connect':
      await handleOpen(state, options)
      return
    case 'session':
      if (rest[0] === 'list') {
        await handleSessionList(options)
        return
      }
      if (rest[0] === 'prune' || rest[0] === 'cleanup') {
        await handleSessionPrune(options)
        return
      }
      if (rest[0] === 'kill' || rest[0] === 'close') {
        throw new Error(`session ${rest[0]} must be dispatched before binding; this is an internal command routing error.`)
      }
      throw new Error(`Unknown session command: ${rest[0] || '(empty)'}`)
    case 'close':
      await handleClose(state, options)
      return
    case 'path':
      await handlePath(state, options)
      return
    case 'app':
      if (rest[0] === 'inspect') {
        await handleAppInspect(state, options)
        return
      }
      throw new Error(`Unknown app command: ${rest[0] || '(empty)'}`)
    case 'doctor':
      await handleDoctor(state, options)
      return
    case 'protocol':
      await handleProtocol(state, rest[0], rest.slice(1).join(' '), options)
      return
    case 'devtools':
      await handleDevtools(state, rest, options)
      return
    case 'relaunch':
    case 'goto':
      await handleRelaunch(state, rest[0], options)
      return
    case 'snapshot':
      await handleSnapshot(state, options, context.scopeRef || null)
      return
    case 'query':
      await handleQuery(state, rest[0], rest.slice(1).join(' '), options, context.scopeRef || null)
      return
    case 'await':
      await handleAwaitCommand(state, rest[0], options, context.scopeRef || null)
      return
    case 'within':
      await dispatch(state, rest.slice(1), options, { scopeRef: rest[0] })
      return
    case 'tap':
    case 'click':
      await handleTap(state, rest[0], options, context.scopeRef || null)
      return
    case 'input':
    case 'fill':
      await handleInput(state, rest[0], rest.slice(1).join(' '), options, context.scopeRef || null)
      return
    case 'wait':
      await handleWait(state, rest[0], options, context.scopeRef || null)
      return
    case 'get':
      await handleGet(state, rest[0], rest[1], rest[2], options, context.scopeRef || null)
      return
    case 'system-info':
      await handleSystemInfo(state, options)
      return
    case 'page-stack':
      await handlePageStack(state, options)
      return
    case 'timeline':
      await handleTimeline(state, rest[0], options)
      return
    case 'logs':
      await handleLogs(state, 'console', rest[0], options)
      return
    case 'exceptions':
      await handleLogs(state, 'exception', rest[0], options)
      return
    case 'eval':
      await handleEval(state, rest.join(' '), options)
      return
    case 'native':
      await handleNative(state, rest[0], rest.slice(1), options)
      return
    case 'call':
      await handleCall(state, rest[0], rest[1], rest.slice(2), options)
      return
    case 'screenshot':
      await handleScreenshot(state, rest[0], options)
      return
    default:
      throw new Error(`Unknown command: ${command}`)
  }
}

function wantsJsonOutput(argv) {
  return argv.includes('--json')
}

function shouldAcquireRuntimeLock(command, state) {
  if (command === undefined || command === 'help' || command === 'session' || command === 'open' || command === 'connect') {
    return false
  }
  return Boolean(runtimeLockName(state && state.config))
}

function buildCliErrorPayload(error) {
  const message = error && error.message ? String(error.message) : String(error || 'Unknown error')
  const raw = error && error.raw ? String(error.raw) : undefined
  const code = error && error.code ? String(error.code) : undefined
  const hint = error && error.hint ? String(error.hint) : undefined
  const log = error && error.log ? String(error.log) : undefined
  const next = error && error.next ? String(error.next) : undefined
  const diagnostics = error && error.diagnostics && typeof error.diagnostics === 'object'
    ? error.diagnostics
    : undefined

  const payload: AnyRecord = {
    ok: false,
    error: {
      message,
    },
  }
  if (code) {
    payload.error.code = code
  }
  if (hint) {
    payload.error.hint = hint
  }
  if (log) {
    payload.error.log = log
  }
  if (next) {
    payload.error.next = next
  }
  if (raw) {
    payload.error.raw = raw
  }
  if (diagnostics) {
    payload.error.diagnostics = diagnostics
  }
  return payload
}

function emitCliError(error, json) {
  const message = error && error.message ? String(error.message) : String(error || 'Unknown error')

  if (json) {
    console.log(JSON.stringify(buildCliErrorPayload(error), null, 2))
    return
  }

  console.error(message)
  if (error && error.hint) {
    console.error(String(error.hint))
  }
  if (error && error.log) {
    console.error(String(error.log))
  }
  if (error && error.diagnostics && typeof error.diagnostics === 'object') {
    console.error(JSON.stringify(error.diagnostics, null, 2))
  }
}

async function main(argv = process.argv.slice(2)) {
  const { positional, options } = parseArgs(argv)
  const command = positional[0]
  const scopedOptions = withDiscoveredProjectScope(options, command)

  if (options.version || command === 'version') {
    console.log(getVersionText())
    return
  }

  if (scopedOptions.help) {
    if (command) {
      printCommandHelp(command)
      return
    }
    printHelp()
    return
  }

  if (command === undefined || command === 'help') {
    if (command === 'help' && positional[1]) {
      printCommandHelp(positional[1])
      return
    }
    printHelp()
    return
  }

  const baseConfig = createDefaultConfig()

  if (command === 'session' && positional[1] === 'list') {
    await handleSessionList(scopedOptions)
    return
  }

  if (command === 'session' && (positional[1] === 'prune' || positional[1] === 'cleanup')) {
    await handleSessionPrune(scopedOptions)
    return
  }

  if (command === 'session' && (positional[1] === 'kill' || positional[1] === 'close')) {
    const targetSession = positional[2]
    if (!targetSession) {
      throw new Error(`session ${positional[1]} requires a session name, e.g. session ${positional[1]} demo`)
    }
    const targetConfig = await resolveSessionConfig(
      targetSession,
      mergeConfigOverrides(baseConfig, buildExplicitOverrides({ ...scopedOptions, session: targetSession })),
    )
    const lock = await acquireSessionLock(targetSession, targetConfig, { command: `session ${positional[1]}` })
    let runtimeLock = null
    try {
      const targetState = await loadSessionState(targetSession, targetConfig)
      const targetRuntimeLockName = runtimeLockName(targetState.config)
      if (targetRuntimeLockName) {
        runtimeLock = await acquireSessionLock(targetRuntimeLockName, targetState.config, { command: `runtime session ${positional[1]}` })
      }
      await handleClose(targetState, {
        ...scopedOptions,
        session: targetSession,
        sessionProvided: true,
        project: targetConfig.projectPath || scopedOptions.project,
      })
    } finally {
      if (runtimeLock) {
        await releaseSessionLock(runtimeLock)
      }
      await releaseSessionLock(lock)
    }
    return
  }

  if (command === 'doctor' && !scopedOptions.sessionProvided && scopedOptions.project && scopedOptions.devtoolsPort) {
    const state = await resolveTransientDoctorState(scopedOptions)
    await dispatch(state, positional, {
      ...scopedOptions,
      session: state.name,
      ephemeralSession: true,
    })
    return
  }

  const lockConfig = await resolveSessionConfig(
    scopedOptions.session,
    mergeConfigOverrides(baseConfig, buildExplicitOverrides(scopedOptions)),
  )
  const lock = await acquireSessionLock(scopedOptions.session, lockConfig, { command })

  let runtimeLock = null
  try {
    const state = await resolveSession(scopedOptions)
    if (shouldAcquireRuntimeLock(command, state)) {
      runtimeLock = await acquireSessionLock(runtimeLockName(state.config), state.config, { command: `runtime ${command}` })
    }
    await syncRouteTimelinePrelude(state, scopedOptions, command)
    await dispatch(state, positional, scopedOptions)
  } finally {
    if (runtimeLock) {
      await releaseSessionLock(runtimeLock)
    }
    await releaseSessionLock(lock)
  }
}

if (require.main === module) {
  const argv = process.argv.slice(2)
  main(argv).catch((error) => {
    emitCliError(error, wantsJsonOutput(argv))
    process.exit(1)
  })
}

module.exports = {
  buildHelpText,
  buildCommandHelpText,
  buildCliErrorPayload,
  getVersionText,
  parseArgs,
  parseFocusRefs,
  normalizeOpenStableWaitError,
  resolveOpenFailureNextAction,
  shouldRetryOpenWithAnotherAutoPort,
  classifyOpenFailureFromStartupHints,
  summarizeDevtoolsStartupHints,
  summarizeOpenResolution,
  shouldClearFailedOpenSession,
  shouldAttemptVisualProbe,
  shouldEmitPreludeNotices,
  summarizeTimelinePayload,
  summarizeSnapshotPayload,
}
