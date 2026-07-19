#!/usr/bin/env node

const path = require('node:path')

type AnyRecord = Record<string, unknown>

/** CLI 配置对象（由调用方传入，字段开放给运行时补充）。 */
interface CliConfig {
  projectPath: string
  autoPort?: string
  devtoolsPort?: string
  cliPath?: string
  sessionDir?: string
  screenshotDir?: string
  tempScreenshotDir?: string
  legacySessionDir?: string
  devtoolsProjectPath?: string
  devtoolsProjectMap?: string
  devtoolsProjectAutoLink?: string
  devtoolsProjectMirror?: string
  interactiveSelectors?: string
  repoRoot?: string
  [key: string]: unknown
}

/** Session 状态对象。携带 config 与运行时字段。 */
interface SessionState {
  name: string
  bound: boolean
  config: CliConfig
  route: string
  runtimeAttached?: boolean
  runtimeLaunchId?: string | null
  runtimeOwnerSession?: string | null
  runtimeAttachedAt?: number | string | null
  runtimeLaunchStatus?: string
  portResolution?: {
    autoPortAssigned: boolean
    devtoolsPortAssigned: boolean
    [key: string]: unknown
  } | null
  routeEvents?: AnyRecord[]
  lastVisualProbe?: unknown
  pendingVisualAction?: unknown
  [key: string]: unknown
}

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
  pickAutoProjectSessionName,
  nextAutoProjectSessionName,
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
  summarizeDevtoolsCliRaw,
} = require('./lib/runtime')

const {
  captureAnnotatedScreenshot,
  captureLayoutScreenshot,
  overlayFocusScreenshot,
  readOfficialMenuButtonRect,
  captureVisualScreenshot,
} = require('./lib/visual')

function mergeRecordLayouts(records: AnyRecord[], rects: AnyRecord[]) {
  const identityOf = (item: AnyRecord) => item && (item.ref || item.businessKey || item.selector || '')
  const byRef = new Map((rects || []).map((item: AnyRecord) => [identityOf(item), item.rectPct]))
  return (records || []).map((record: AnyRecord) => ({
    ...record,
    ...(byRef.has(identityOf(record)) ? { rectPct: byRef.get(identityOf(record)) } : {}),
  }))
}

function flattenRuntimeNodes(nodes: AnyRecord[], parentRef: string = ''): AnyRecord[] {
  const flattened: AnyRecord[] = []
  for (const node of nodes || []) {
    const current: AnyRecord = {
      ...node,
      parentRef,
    }
    flattened.push(current)
    flattened.push(...flattenRuntimeNodes((node.children as AnyRecord[]) || [], String(current.ref || current.businessKey || '')))
  }
  return flattened
}

function shouldEmitPreludeNotices(command: string) {
  return !['logs', 'exceptions', 'await', 'wait'].includes(String(command || ''))
}

/**
 * @param {any} state
 * @param {string} route
 * @param {string|null} scopeRef
 * @param {any} [options]
 */
function shouldAttemptVisualProbe(state: SessionState, route: string, scopeRef: string | null = null, options: AnyRecord = {}) {
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

  return (state.lastVisualProbe as AnyRecord).route !== route
}

function markPendingVisualAction(state: SessionState, action: string, route: string) {
  state.pendingVisualAction = {
    action,
    route,
    ts: Date.now(),
  }
}

async function captureVisualProbeForSnapshot(miniProgram: AnyRecord, page: AnyRecord, state: SessionState, records: AnyRecord[], screenshotPath: string) {
  try {
    return await createVisualProbe({
      miniProgram,
      page,
      records,
      config: state.config,
      screenshotPath,
      cleanupScreenshot: Boolean(screenshotPath),
      captureScreenshot: async (instance: AnyRecord, targetPath: string) => captureScreenshotToPath(instance, targetPath, 2500),
    })
  } catch (_) {
    return null
  }
}

function maybeBuildImplicitVisualChange(state: SessionState, currentProbe: AnyRecord | null) {
  const pending = state.pendingVisualAction
  const previous = state.lastVisualProbe
  if (!pending || !previous || !currentProbe) {
    state.lastVisualProbe = currentProbe || state.lastVisualProbe || null
    state.pendingVisualAction = null
    return null
  }

  let visual: AnyRecord | null = null
  if ((pending as AnyRecord).route === currentProbe.route && (previous as AnyRecord).route === currentProbe.route) {
    visual = buildVisualDiffSummary(previous as AnyRecord, currentProbe)
  }

  state.lastVisualProbe = currentProbe
  state.pendingVisualAction = null
  return visual
}

function printHelp() {
  console.log(buildHelpText())
}

function printCommandHelp(command: string) {
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

function buildExplicitOverrides(options: AnyRecord) {
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

function withDiscoveredProjectScope(options: AnyRecord, command: string): AnyRecord {
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
  }
}

/**
 * 省略 --session 时：按项目生成/复用 {slug}-xN。
 * - 默认复用已有最大序号自动 session
 * - open --fresh 且未显式 session 时分配下一个 xN
 * 不依赖 agent 名称。
 */
async function ensureImplicitSessionName(options: AnyRecord, command: string): Promise<AnyRecord> {
  if (options.sessionProvided) {
    return options
  }

  const projectPath = String(options.project || '').trim()
  if (!projectPath) {
    if (!options.session || options.session === 'default') {
      return {
        ...options,
        session: '',
      }
    }
    return options
  }

  const baseConfig = mergeConfigOverrides(createDefaultConfig(), buildExplicitOverrides(options))
  const states = await listSessionStates({
    ...baseConfig,
    projectPath,
  })
  const existingNames = states.map((item: AnyRecord) => String(item.name || '')).filter(Boolean)

  const allocateFresh = (command === 'open' || command === 'connect') && Boolean(options.fresh)
  const sessionName = allocateFresh
    ? nextAutoProjectSessionName(existingNames, projectPath)
    : pickAutoProjectSessionName(existingNames, projectPath)

  return {
    ...options,
    session: sessionName,
    sessionProvided: false,
    sessionAutoAssigned: true,
  }
}

async function resolveSession(options: AnyRecord) {
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

  // session 不固化 autoPort：后续命令先从 runtime 池按 sessionName 回绑，
  // 避免 ensureSessionPorts 重新分配空闲端口导致连到错误 endpoint。
  if (!explicitOverrides.autoPort && !options.fresh) {
    await bindSessionRuntimeFromPool(state)
  }

  await ensureSessionPorts(state)
  return state
}

/**
 * 从 RuntimeLaunchRecord 池为当前 session 回绑 autoPort（瞬态，不写回 session 文件）。
 * 优先匹配同 sessionName 的 live launch；否则同项目唯一 live。
 * 探测失败的 launch 标记为 stale，继续尝试同 session 的其他候选。
 */
async function bindSessionRuntimeFromPool(state: SessionState, options: { requireLive?: boolean } = {}): Promise<boolean> {
  const projectPath = String(state.config.projectPath || '').trim()
  if (!projectPath) {
    return false
  }
  if (String((state.config as AnyRecord).autoPort || '').trim()) {
    return true
  }

  const requireLive = options.requireLive !== false
  const launches = await listRuntimeLaunches({ ...state.config, projectPath })
  const resolvedProject = path.resolve(projectPath)
  const preferred = String(state.name || '').trim()
  const candidates = launches.filter((item: AnyRecord) => {
    if (!item || !item.autoPort) {
      return false
    }
    // kill/close 需要用历史 autoPort 抢 runtime 锁；open 后续命令仍默认只绑 live
    if (requireLive && item.status !== 'live') {
      return false
    }
    const itemProject = item.projectPath ? path.resolve(String(item.projectPath)) : ''
    return itemProject === resolvedProject
  })

  // 同 sessionName 优先，保持 registry 的 updatedAt 降序
  const ordered = [
    ...candidates.filter((item: AnyRecord) => String(item.sessionName || '').trim() === preferred),
    ...candidates.filter((item: AnyRecord) => String(item.sessionName || '').trim() !== preferred),
  ]

  // 无同名时仅允许唯一 live（与 selectRuntimeLaunchForSession 一致）
  const own = ordered.filter((item: AnyRecord) => String(item.sessionName || '').trim() === preferred)
  const tryList = own.length > 0
    ? own
    : (candidates.length === 1 ? candidates : [])

  for (const selected of tryList) {
    if (requireLive) {
      const live = await isAutomationEndpointLive(
        { ...state.config, autoPort: selected.autoPort },
        { timeoutMs: 1000 },
      ).catch(() => false)
      if (!live) {
        if (selected.id) {
          await updateRuntimeLaunch(selected.id, state.config, { status: 'stale' }).catch(() => null)
        }
        continue
      }
    }

    ;(state.config as AnyRecord).autoPort = String(selected.autoPort)
    if (selected.devtoolsPort) {
      ;(state.config as AnyRecord).devtoolsPort = String(selected.devtoolsPort)
    }
    if (selected.id) {
      state.runtimeLaunchId = String(selected.id)
    }
    if (selected.sessionName && selected.sessionName !== state.name) {
      state.runtimeAttached = true
      state.runtimeOwnerSession = String(selected.sessionName)
    }
    return true
  }

  return false
}

async function resolveTransientDoctorState(options: AnyRecord) {
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

function resolveOpenTimeoutMs(options: AnyRecord) {
  const value = Number(options.timeout || DEFAULT_OPEN_TIMEOUT_MS)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_OPEN_TIMEOUT_MS
}

function resolveOpenStableTimeoutMs(options: AnyRecord) {
  const openTimeoutMs = resolveOpenTimeoutMs(options)
  return Math.max(1000, Math.min(DEFAULT_OPEN_STABLE_TIMEOUT_MS, Math.floor(openTimeoutMs / 2)))
}

function createOpenTimeoutError(timeoutMs: number) {
  const error = new Error(`open timed out after ${timeoutMs}ms`) as unknown as AnyRecord
  error.code = 'OPEN_TIMEOUT'
  error.hint = `phase=open; timeoutMs=${timeoutMs}`
  return error
}

async function withOpenTimeout(task: () => Promise<AnyRecord>, timeoutMs: number): Promise<AnyRecord> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(task),
      new Promise<AnyRecord>((_resolve, reject) => {
        timer = setTimeout(() => reject(createOpenTimeoutError(timeoutMs)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

async function cleanupStartedOpenRuntime(state: SessionState) {
  const closeResult = closeDevtoolsProject(state.config, { timeoutMs: 30000 }) as unknown as AnyRecord
  await waitAfterDevtoolsCloseRequest(closeResult)
  const cleanup = {
    projectClosed: Boolean(closeResult && closeResult.ok),
    closeVerified: false,
    closeAttempted: Boolean(closeResult && closeResult.attempted),
  } as unknown as AnyRecord

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

async function waitAfterDevtoolsCloseRequest(closeResult: AnyRecord) {
  if (closeResult && closeResult.ok && DEVTOOLS_CLOSE_GRACE_MS > 0) {
    await sleep(DEVTOOLS_CLOSE_GRACE_MS)
  }
}

async function recordStartedRuntimeLaunch(state: SessionState, metadata: AnyRecord = {}) {
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

async function markStartedRuntimeLaunch(state: SessionState, patch: AnyRecord = {}) {
  if (!state || !state.runtimeLaunchId) {
    return null
  }
  return await updateRuntimeLaunch(state.runtimeLaunchId, state.config, patch).catch(() => null)
}

/**
 * 成功 open/connect 后确保 runtime 池有一条 live 记录。
 * connected/attached 模式原先不写 launch，导致后续命令无法按 session 回绑 autoPort。
 */
async function ensureLiveRuntimeLaunch(state: SessionState, metadata: AnyRecord = {}) {
  const autoPort = String((state.config as AnyRecord).autoPort || metadata.autoPort || '').trim()
  if (!autoPort || !state.config.projectPath) {
    return null
  }

  const automationArgs = buildAutomationArgs(state.config)
  const patch = {
    ...metadata,
    status: 'live',
    autoPort,
    projectStrategy: automationArgs.projectStrategy,
    devtoolsProjectPath: automationArgs.devtoolsProjectPath,
    devtoolsPort: String((state.config as AnyRecord).devtoolsPort || metadata.devtoolsPort || ''),
    route: metadata.route || state.route || '',
  } as AnyRecord

  if (state.runtimeLaunchId) {
    const updated = await updateRuntimeLaunch(state.runtimeLaunchId, state.config, patch).catch(() => null)
    if (updated) {
      state.runtimeLaunchStatus = 'live'
      return updated
    }
  }

  // 尝试复用同 session + 同 autoPort 的已有记录
  const launches = await listRuntimeLaunches({ ...state.config, projectPath: state.config.projectPath })
  const existing = launches.find((item: AnyRecord) => (
    String(item.sessionName || '').trim() === state.name
    && String(item.autoPort || '').trim() === autoPort
  ))
  if (existing && existing.id) {
    const updated = await updateRuntimeLaunch(existing.id, state.config, patch).catch(() => null)
    if (updated) {
      state.runtimeLaunchId = String(existing.id)
      state.runtimeLaunchStatus = 'live'
      return updated
    }
  }

  const record = await recordRuntimeLaunch(state.name, state.config, {
    id: `${state.name}-${Date.now()}-${process.pid}`,
    ...patch,
  })
  if (record && record.id) {
    state.runtimeLaunchId = String(record.id)
    state.runtimeLaunchStatus = 'live'
  }

  // 同 session 其他不同 autoPort 的 live 记录标 stale，避免后续回绑到死端口
  try {
    const launches = await listRuntimeLaunches({ ...state.config, projectPath: state.config.projectPath })
    for (const item of launches) {
      if (!item || !item.id || item.status !== 'live') {
        continue
      }
      if (String(item.sessionName || '').trim() !== state.name) {
        continue
      }
      if (String(item.autoPort || '').trim() === autoPort) {
        continue
      }
      await updateRuntimeLaunch(item.id, state.config, { status: 'stale' }).catch(() => null)
    }
  } catch (_) {
    // ignore cleanup failures
  }

  return record
}

async function enrichOpenFailure(error: AnyRecord, state: SessionState, options: AnyRecord) {
  const openError: AnyRecord = error as AnyRecord || new Error('open failed') as unknown as AnyRecord
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

function shouldCleanupStartedOpenRuntime(state: SessionState, openOptions: AnyRecord = {}, error: AnyRecord = {}) {
  if (error && error.runtimeMayContinue) {
    return false
  }
  return openOptions.mode === 'started' && !state.runtimeAttached
}

function shouldClearFailedOpenSession(closeResult: AnyRecord) {
  if (!closeResult || !closeResult.attempted) {
    return true
  }
  return Boolean(closeResult.ok)
}

async function openSessionWithDiagnostics(state: SessionState, options: AnyRecord, openOptions: AnyRecord = {}) {
  try {
    // --timeout 约束整段 open 连接（含 enable + connect 重试），到期统一 OPEN_TIMEOUT
    return await withOpenTimeout(
      () => connectOpenSession(state, options, openOptions),
      resolveOpenTimeoutMs(options),
    )
  } catch (error: unknown) {
    const openError = await enrichOpenFailure(error as AnyRecord, state, options)
    if (shouldCleanupStartedOpenRuntime(state, openOptions, openError)) {
      const cleanup = await cleanupStartedOpenRuntime(state).catch((cleanupError) => ({
        projectClosed: false,
        closeAttempted: false,
        sessionCleared: false,
        error: cleanupError && cleanupError.message ? String(cleanupError.message) : String(cleanupError),
      }))
      openError.diagnostics = {
        ...((openError.diagnostics as AnyRecord) || {}),
        cleanup,
      }
    }
    throw openError
  }
}

async function handleOpen(state: SessionState, options: AnyRecord) {
  assertProjectPath(state.config)

  const currentEndpointLive = state.config.autoPort
    ? await isAutomationEndpointLive(state.config, { timeoutMs: 1000 }).catch(() => false)
    : false
  if (!currentEndpointLive && !options.fresh && !options.autoPort) {
    const attachResult = await resolveAttachableRuntime(state)
    if (attachResult.mode === 'attach') {
      const sessionInfo = attachResult.session as AnyRecord
      // 从 runtime 池获取 autoPort，不依赖 session 固化
      const autoPort = sessionInfo.autoPort as string | undefined
      if (autoPort) {
        (state.config as AnyRecord).autoPort = autoPort
      }
      // 检查 endpoint 是否存活
      const live = await isAutomationEndpointLive(state.config, { timeoutMs: 1000 }).catch(() => false)
      if (!live) {
        // runtime record 标记为 stale 但实际不可用，继续走 start 流程
        delete (state.config as AnyRecord).autoPort
      } else {
        await saveSessionState(state)
        const attached = await openSessionWithDiagnostics(state, options, {
          mode: 'attached',
          attachedTo: sessionInfo.name || '',
        })
        await ensureLiveRuntimeLaunch(state, {
          route: attached.path || '',
          autoPort: attached.autoPort || state.config.autoPort,
          devtoolsPort: attached.devtoolsPort || state.config.devtoolsPort,
        })
        await saveSessionState(state)
        emitOpenResult(attached, options)
        return
      }
    }
    if (attachResult.mode === 'ambiguous') {
      const error = new Error('同项目存在多个 live automation session，open 不会静默选择；请显式使用其中一个 --session，或传 --fresh 尝试启动新 runtime。') as unknown as AnyRecord
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
    } catch (error: unknown) {
      const caughtError: AnyRecord = error as AnyRecord
      if (!shouldRetryOpenWithAnotherAutoPort(state, options, openMode, caughtError, attempt)) {
        caughtError.diagnostics = {
          ...((caughtError.diagnostics as AnyRecord) || {}),
          attemptedAutoPorts: [...attemptedAutoPorts, state.config.autoPort].filter(Boolean),
        }
        throw caughtError
      }

      attemptedAutoPorts.push(state.config.autoPort as string)
      await reassignOpenAutoPort(state, attemptedAutoPorts)
    }
  }

  if (!result) {
    throw new Error('open failed without a result')
  }

  if (attemptedAutoPorts.length) {
    result.attemptedAutoPorts = [...attemptedAutoPorts, result.autoPort].filter(Boolean)
  }
  // 任意成功模式都要把 autoPort 写回 runtime 池，后续 snapshot/click 才能回绑
  await ensureLiveRuntimeLaunch(state, {
    route: result.path || '',
    autoPort: result.autoPort || state.config.autoPort,
    devtoolsPort: result.devtoolsPort || state.config.devtoolsPort,
  })
  await saveSessionState(state)
  emitOpenResult(result, options)
}

function shouldRetryOpenWithAnotherAutoPort(state: SessionState, options: AnyRecord, openMode: string, error: AnyRecord = {}, attempt: number = 1) {
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
  const startupHints = ((error.diagnostics as AnyRecord | undefined)?.startupHints as AnyRecord[] | undefined) || []
  const startupHintCodes = new Set(startupHints.map((item: AnyRecord) => item && item.code).filter(Boolean) as string[])
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

  const causeMessage = String(error && (error.cause as AnyRecord) && (error.cause as AnyRecord).message ? (error.cause as AnyRecord).message : '')
  return /Failed connecting to ws:\/\/127\.0\.0\.1:/iu.test(causeMessage)
}

async function reassignOpenAutoPort(state: SessionState, attemptedAutoPorts: string[] = []) {
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
  if (state.portResolution) {
    state.portResolution.autoPortAssigned = true
  }
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

async function connectOpenSession(state: SessionState, options: AnyRecord, openOptions: AnyRecord = {}) {
  return await withMiniProgram(state, async (miniProgram: AnyRecord) => {
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
      } catch (error: unknown) {
        const normalized = normalizeOpenStableWaitError(error as AnyRecord)
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
      toolInfo: runtimeProbe && (runtimeProbe as AnyRecord).toolInfo ? (runtimeProbe as AnyRecord).toolInfo : undefined,
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
    allowEnable: true,
    connectTimeoutMs: resolveOpenTimeoutMs(options),
    onProgress(phase: string) {
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

function emitOpenResult(result: AnyRecord, options: AnyRecord) {
  const pathLabel = result.path || (result.appReady === false ? '(warming up)' : '(no page)')
  const sessionLabel = options.session ? ` session=${options.session}` : ''
  const autoSessionLabel = options.sessionAutoAssigned ? ' (auto-session)' : ''
  emit({
    message: `已连接 mode=${result.mode} path=${pathLabel} project=${result.projectPath} strategy=${result.projectStrategy} devtoolsProject=${result.devtoolsProjectPath} devtoolsPort=${result.devtoolsPort} autoPort=${result.autoPort}${sessionLabel}${autoSessionLabel}${result.attachedTo ? ` attachedTo=${result.attachedTo}` : ''}${result.autoPortAssigned ? ' (auto)' : ''}${result.appReady === false ? ' appReady=false' : ''}${result.stableTimeout ? ' stable=false' : ''}`,
    mode: result.mode,
    attachedTo: result.attachedTo,
    appReady: result.appReady,
    path: result.path,
    session: options.session || undefined,
    sessionAutoAssigned: Boolean(options.sessionAutoAssigned) || undefined,
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

async function resolveAttachableRuntime(state: SessionState) {
  const projectPath = path.resolve(state.config.projectPath || '')
  if (!projectPath) {
    return { mode: 'none', sessions: [] }
  }

  // RuntimeLaunchRecord 管理 DevTools 窗口连接信息，session 不再固化 autoPort
  const launches = await listRuntimeLaunches({ ...state.config, projectPath })
  const liveLaunches = launches.filter((item: AnyRecord) => item && item.status === 'live' && item.autoPort)
  const sameProjectLaunches = []

  for (const launch of liveLaunches) {
    if (launch.projectPath && path.resolve(launch.projectPath) !== projectPath) {
      continue
    }
    const live = await isAutomationEndpointLive({ ...state.config, autoPort: launch.autoPort }, { timeoutMs: 1000 }).catch(() => false)
    sameProjectLaunches.push({
      ...launch,
      status: live ? 'live' : 'stale',
    })
  }

  // 同 sessionName 优先；否则同项目唯一 live
  const attachableSessions = sameProjectLaunches.map((item: AnyRecord) => ({
    name: item.sessionName || '',
    projectPath: item.projectPath || '',
    autoPort: item.autoPort || '',
    devtoolsPort: item.devtoolsPort || '',
    status: item.status || 'stale',
    route: item.route || '',
  }))
  const selected = selectAttachableRuntimeSession(attachableSessions, state.name)
  if (selected.mode !== 'attach') {
    return selected
  }

  return {
    mode: 'attach',
    session: selected.session,
  }
}

function summarizeDevtoolsStartupHints(logPayload: AnyRecord) {
  const rules = [
    {
      code: 'login-expired',
      pattern: /INVALID_LOGIN|access_token\s*expired|errcode\s*=\s*42001|code:\s*10\b/iu,
      message: 'DevTools 日志报告登录态失效（INVALID_LOGIN / access_token expired / 42001）；请在微信开发者工具中重新登录后再 open。',
    },
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
  const files = ((logPayload && logPayload.files) || []) as AnyRecord[]
  const fileEntries: AnyRecord[] = files.map((item: AnyRecord) => ({
    path: String(item && item.path ? item.path : ''),
    lines: Array.isArray(item && item.lines) ? item.lines : [],
  }))

  const collectFileHints = (file: AnyRecord, seen: Set<string>) => {
    const fileHints: AnyRecord[] = []
    for (const line of (file.lines as unknown[]) || []) {
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

  const timestampedFiles = fileEntries.filter((file: AnyRecord) => /(?:^|[\\/])logs[\\/].+\.log$/iu.test(String(file.path)))
  const fallbackFiles = fileEntries.filter((file: AnyRecord) => !timestampedFiles.includes(file))
  const groups = timestampedFiles.length ? [timestampedFiles] : [fallbackFiles]

  for (const group of groups) {
    const seen = new Set<string>()
    for (const file of group) {
      const hints = collectFileHints(file, seen)
      if (hints.length) {
        return hints
      }
    }
  }

  return []
}

function resolveStartupIssueMessage(hints: AnyRecord[] = [], code = '') {
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

function resolveStartupIssueRaw(hints: AnyRecord[] = [], code = '', summaryLine = '') {
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

function classifyOpenFailureFromStartupHints(hints: AnyRecord[] = [], options: AnyRecord = {}) {
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

function compactStartupHints(hints: AnyRecord[] = []) {
  return (hints || []).slice(0, 3).map((item: AnyRecord) => ({
    code: item.code,
    sample: String(item.sample || '').slice(0, 240),
  }))
}

async function collectDevtoolsStartupHints(state: SessionState, options: AnyRecord = {}) {
  try {
    // 默认只看最近改动的日志文件，避免整天前的 41002 误导本次 open
    const maxAgeMs = Number(options.maxAgeMs || 10 * 60 * 1000)
    const now = Date.now()
    const payload = await collectDevtoolsLogs(state.config, {
      limit: 220,
      files: 6,
      grep: 'appid missing|41002|routeTo appLaunch timeout|triggerAppRouteDone timeout|start cli server error|10055|INVALID_LOGIN|access_token',
    })
    const files = Array.isArray(payload.files)
      ? (payload.files as AnyRecord[]).filter((file: AnyRecord) => {
        const mtimeMs = Number(file.mtimeMs || 0)
        if (!mtimeMs) {
          return true
        }
        return (now - mtimeMs) <= maxAgeMs
      })
      : []
    return summarizeDevtoolsStartupHints({ ...payload, files })
  } catch (_) {
    return []
  }
}

async function collectDevtoolsLogContext(state: SessionState, grep = '') {
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

function summarizeAutomationProbeHint(condition: AnyRecord, probe: AnyRecord) {
  if (!probe || !probe.connected) {
    return `phase=${condition.kind}; last=tool-connect`
  }

  const failingProbe = ((probe.probes as AnyRecord[]) || []).find((item: AnyRecord) => !item.ok)
  if (failingProbe) {
    if (failingProbe.timeout) {
      return `phase=${condition.kind}; last=${failingProbe.method} timeout`
    }
    return `phase=${condition.kind}; last=${failingProbe.method} error`
  }

  return `phase=${condition.kind}`
}

function summarizeOpenResolution(options: AnyRecord, liveSameProjectSessions: AnyRecord[] = []) {
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

function resolveOpenFailureNextAction(options: AnyRecord, liveSameProjectSessions: AnyRecord[] = []) {
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

async function waitForAutomationCondition(state: SessionState, condition: AnyRecord, options: AnyRecord) {
  const timeoutMs = resolveAwaitTimeoutMs(condition, options.timeout)
  const pollMs = Math.max(200, Number(options.pollMs || 500))
  const startedAt = Date.now()
  let lastProbe: AnyRecord | null = null

  while (Date.now() - startedAt <= timeoutMs) {
    lastProbe = await probeAutomationRuntime(state.config, {
      timeoutMs: Number(options.probeTimeoutMs || Math.min(5000, pollMs * 4)),
    })

    if (lastProbe && condition.kind === 'tool-ready' && lastProbe.connected) {
      return {
        ok: true,
        condition: condition.raw,
        endpoint: lastProbe.endpoint,
        elapsedMs: Date.now() - startedAt,
      }
    }

    if (lastProbe && condition.kind === 'app-ready' && lastProbe.appReady) {
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
  const error = new Error(`await ${condition.raw} timed out after ${timeoutMs}ms`) as unknown as AnyRecord
  error.code = 'AWAIT_TIMEOUT'
  error.hint = summarizeAutomationProbeHint(condition, lastProbe as AnyRecord)
  if (logContext.log) {
    error.log = logContext.log
    error.next = 'devtools logs'
  }
  throw error
}

function resolveExplicitAwaitCondition(rawValue: unknown, command: string, options: AnyRecord, context: AnyRecord = {}) {
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

async function buildOpenFailureDiagnostics(state: SessionState, options: AnyRecord) {
  const automationArgs = buildAutomationArgs(state.config)
  const sessions = await listSessionStates(createDefaultConfig())
  const projectPath = path.resolve(state.config.projectPath || '')
  const liveSameProjectSessions: AnyRecord[] = []
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

async function handleDoctor(state: SessionState, options: AnyRecord) {
  // 允许省略 --session：上游 ensureImplicitSessionName 已按项目分配/复用 slug-xN
  const persistSession = !options.ephemeralSession
  if (!persistSession && !(options.ephemeralSession && options.project && options.devtoolsPort)) {
    throw new Error('doctor 需要可解析的 session 或 ephemeral --project + --devtools-port。')
  }
  assertProjectPath(state.config)

  // 先执行 automation 诊断，成功后再保存 session。
  // 避免因 DevTools 时序问题（如 appid 未就绪）导致 session 被污染。
  let automationMetadata: AnyRecord | null = null
  let automationError: AnyRecord | null = null
  try {
    automationMetadata = enableAutomation(state.config)
  } catch (error: unknown) {
    const caughtError = error as AnyRecord
    automationError = {
      message: caughtError && caughtError.message ? String(caughtError.message) : String(caughtError),
      raw: caughtError && caughtError.raw ? String(caughtError.raw) : undefined,
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

  if (persistSession && probe && probe.connected) {
    await saveSessionState(state)
  }

  const automationArgs = buildAutomationArgs(state.config)
  const payload: AnyRecord = {
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
    lines.push(`automation=${(payload.automation as AnyRecord).ok ? 'ok' : 'failed'}`)
    const automation = payload.automation as AnyRecord
    if (automation.startupIssue && (automation.startupIssue as AnyRecord).code) {
      lines.push(`startupIssue=${(automation.startupIssue as AnyRecord).code}`)
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

function parseJsonArgument(rawValue: string, fallback: AnyRecord) {
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return fallback
  }
  try {
    return JSON.parse(String(rawValue))
  } catch (error) {
    throw new Error(`Invalid JSON argument: ${rawValue}`)
  }
}

async function handleProtocol(state: SessionState, method: string, rawParams: string, options: AnyRecord) {
  if (!method) {
    throw new Error('protocol requires a method, e.g. protocol Tool.getInfo')
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

async function handleDevtools(state: SessionState, rest: string[], options: AnyRecord) {
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

async function handleSessionList(options: AnyRecord = {}) {
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
    ? sessions.filter((item: AnyRecord) => path.resolve(item.projectPath || '') === projectFilter)
    : (options.all ? sessions : [])
  const sessionsWithStatus = await Promise.all(visibleSessions.map(async (item: AnyRecord) => {
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

async function shutdownOwnedRuntime(state: SessionState) {
  const result: AnyRecord = {
    runtimeShutdown: true,
    automationClosed: false,
    projectClosed: false,
    closeAttempted: false,
  }

  await withMiniProgram(state, async (miniProgram: AnyRecord) => {
    await shutdownMiniProgram(miniProgram)
    result.automationClosed = true
  }).catch((error: unknown) => {
    const caughtError = error as AnyRecord
    result.automationError = caughtError && caughtError.message ? String(caughtError.message) : String(caughtError)
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

async function handleSessionPrune(options: AnyRecord) {
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
  const visibleSessions = sessions.filter((item: AnyRecord) => path.resolve(item.projectPath || '') === projectFilter)
  const sessionsWithStatus = await Promise.all(visibleSessions.map(async (item: AnyRecord) => {
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
      } as unknown as AnyRecord

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
    } as unknown as AnyRecord

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
    const error = new Error(`session prune failed for ${failed.length} item(s)`) as unknown as AnyRecord
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

async function handlePath(state: SessionState, options: AnyRecord) {
  const pathValue = await withMiniProgram(state, async (miniProgram: AnyRecord) => {
    const page = await getCurrentPage(miniProgram)
    state.route = page.path
    return page.path
  })

  await saveSessionState(state)
  emit({ message: pathValue, path: pathValue }, options)
}

function isTabBarRoute(route: string, runtimeConfig: AnyRecord) {
  const normalizedRoute = normalizeRoutePath(route)
  const list = runtimeConfig && runtimeConfig.tabBar && Array.isArray((runtimeConfig.tabBar as AnyRecord).list)
    ? ((runtimeConfig.tabBar as AnyRecord).list as AnyRecord[])
    : []
  return list.some((item: AnyRecord) => normalizeRoutePath(item && (item.pagePath || item.path)) === normalizedRoute)
}

async function handleRelaunch(state: SessionState, route: string, options: AnyRecord) {
  if (!route) {
    throw new Error('goto/relaunch requires a route, e.g. goto /pages/index/index')
  }
  const waitMs = Number(options.wait || 1500)
  const targetPath = normalizeRoutePath(route)
  const awaitCondition = resolveExplicitAwaitCondition(options.await, 'goto', options, { route: targetPath })
  const payload = await withMiniProgram(state, async (miniProgram: AnyRecord) => {
    const pageBefore = await getCurrentPage(miniProgram).catch(() => null)
    const pathBefore = pageBefore && pageBefore.path ? pageBefore.path : state.route || ''
    const runtimeConfig = await getRuntimeAppConfig(miniProgram).catch(() => ({ tabBar: { list: [] } }))
    const method = isTabBarRoute(route, runtimeConfig) && typeof miniProgram.switchTab === 'function'
      ? 'switchTab'
      : 'reLaunch'

    if (method === 'switchTab') {
      // DevTools automation 要求路由以 / 开头，否则视为相对路径拼接
      const absoluteRoute = route.startsWith('/') ? route : `/${route}`
      await (miniProgram.switchTab as (r: string) => Promise<unknown>)(absoluteRoute)
    } else {
      // DevTools automation 要求路由以 / 开头，否则视为相对路径拼接
      const absoluteRoute = route.startsWith('/') ? route : `/${route}`
      await (miniProgram.reLaunch as (r: string) => Promise<unknown>)(absoluteRoute)
    }
    await sleep(waitMs)
    const routeResult: AnyRecord = awaitCondition
      ? await waitForMiniProgramCondition(miniProgram, state, awaitCondition, {
        timeout: options.timeout,
        pathBefore,
      }).then((result: AnyRecord) => ({
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

    state.route = String(routeResult.path)
    return {
      message: String(routeResult.path),
      path: String(routeResult.path),
      method,
    }
  })

  markPendingVisualAction(state, 'goto', payload.path)
  await saveSessionState(state)
  emit(payload, options)
}

async function handleSnapshot(state: SessionState, options: AnyRecord, scopeRef: string | null = null) {
  const awaitCondition = resolveExplicitAwaitCondition(options.await, 'snapshot', options)
  const payload = await withMiniProgram(state, async (miniProgram: AnyRecord) => {
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
      const systemInfo = await (miniProgram.systemInfo as () => Promise<AnyRecord>)()
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

async function handleQuery(state: SessionState, mode: string, value: string, options: AnyRecord, scopeRef: string | null = null) {
  const payload = await withMiniProgram(state, async (miniProgram: AnyRecord) => {
    const page = await getCurrentPage(miniProgram)
    const result = await queryRecords(page, state, mode, value, scopeRef)
    Object.assign(state, result.state)
    return result
  })

  await saveSessionState(state)
  emit(payload, options)
}

async function handleTap(state: SessionState, target: string, options: AnyRecord, scopeRef: string | null = null) {
  const waitMs = Number(options.wait || 1200)
  const awaitCondition = resolveExplicitAwaitCondition(options.await, 'click', options)
  const payload = await withMiniProgram(state, async (miniProgram: AnyRecord) => {
    const page = await getCurrentPage(miniProgram)
    const pathBefore = page.path
    const element = await resolveTarget(page, state, target, scopeRef)
    await element.tap()
    await sleep(waitMs)
    const routeResult: AnyRecord = awaitCondition
      ? await waitForMiniProgramCondition(miniProgram, state, awaitCondition, {
        timeout: options.timeout,
        pathBefore,
        scopeRef,
      }).then(async (result: AnyRecord) => ({
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

async function handleInput(state: SessionState, target: string, value: string, options: AnyRecord, scopeRef: string | null = null) {
  const waitMs = Number(options.wait || 500)
  const payload = await withMiniProgram(state, async (miniProgram: AnyRecord) => {
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

async function handleAwaitCommand(state: SessionState, rawCondition: string, options: AnyRecord, scopeRef: string | null = null) {
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

  const payload = await withMiniProgram(state, async (miniProgram: AnyRecord) => {
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

async function handleWait(state: SessionState, target: string, options: AnyRecord, scopeRef: string | null = null) {
  const timeoutMs = Number(options.wait || 10000)

  await withMiniProgram(state, async (miniProgram: AnyRecord) => {
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

    const error = new Error(`wait timeout: ${target}`) as unknown as AnyRecord
    error.code = 'WAIT_TIMEOUT'
    error.hint = `target=${target}`
    throw error
  })

  await saveSessionState(state)
  emit({ message: `等待完成 ${target}` }, options)
}

async function handleGet(state: SessionState, what: string, target: string, detail: string, options: AnyRecord, scopeRef: string | null = null) {
  const payload = await withMiniProgram(state, async (miniProgram: AnyRecord) => {
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

async function handleEval(state: SessionState, source: string, options: AnyRecord) {
  const script = options.stdin ? await readStdin() : source
  const payload = await withMiniProgram(state, async (miniProgram: AnyRecord) => {
    const result = await evaluateInMiniProgram(miniProgram, script)
    return {
      result,
      message: options.json ? undefined : JSON.stringify(result, null, 2),
    }
  })

  await saveSessionState(state)
  emit(payload, options)
}

async function handleNative(state: SessionState, method: string, args: string[], options: AnyRecord) {
  const waitMs = Number(options.wait || 800)
  const awaitCondition = resolveExplicitAwaitCondition(options.await, 'native', options)
  const payload = await withMiniProgram(state, async (miniProgram: AnyRecord) => {
    const page = await getCurrentPage(miniProgram)
    const pathBefore = page.path
    const result = await callNativeMethod(miniProgram, method, args)
    if (waitMs > 0) {
      await sleep(waitMs)
    }
    const routeResult: AnyRecord = awaitCondition
      ? await waitForMiniProgramCondition(miniProgram, state, awaitCondition, {
        timeout: options.timeout,
        pathBefore,
      }).then(async (awaitResult: AnyRecord) => ({
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

async function handleSystemInfo(state: SessionState, options: AnyRecord) {
  const payload = await withMiniProgram(state, async (miniProgram: AnyRecord) => {
    const systemInfo = await getSystemInfo(miniProgram)
    return {
      systemInfo,
      message: options.json ? undefined : JSON.stringify(systemInfo, null, 2),
    }
  })

  await saveSessionState(state)
  emit(payload, options)
}

async function handlePageStack(state: SessionState, options: AnyRecord) {
  const payload = await withMiniProgram(state, async (miniProgram: AnyRecord) => {
    const pages = await getPageStack(miniProgram)
    return {
      pages,
      lines: pages.map((item: AnyRecord, index: number) => `${index + 1}. ${item.path}`),
    }
  })

  await saveSessionState(state)
  emit(payload, options)
}

function buildObservedEdges(routeEvents: AnyRecord[] | undefined) {
  return (routeEvents || []).map((event: AnyRecord) => ({
    from: event.from,
    to: event.to,
    method: event.openType,
  }))
}

async function handleAppInspect(state: SessionState, options: AnyRecord) {
  assertProjectPath(state.config)
  const sections = normalizeInspectSections(options)
  const recentRoutes = getStoredRouteTimeline(state, { limit: 10 })
  const observedEdges = buildObservedEdges(state.routeEvents)
  let runtimeConfig: AnyRecord = {}
  let current = state.route || null
  let pageStack: AnyRecord[] = []
  let runtimeWarning: AnyRecord | string | null = null

  if (state.bound) {
    try {
      const live = await withMiniProgram(state, async (miniProgram: AnyRecord) => {
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
      runtimeConfig = (live.runtimeConfig as AnyRecord) || {}
      pageStack = Array.isArray(live.pageStack) ? (live.pageStack as AnyRecord[]) : []
      current = live.current || (pageStack.length ? pageStack[pageStack.length - 1].path : current)
    } catch (error: unknown) {
      const caughtError = error as AnyRecord
      runtimeWarning = `runtime inspect skipped: ${caughtError && caughtError.message ? caughtError.message : caughtError}`
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

async function handleTimeline(state: SessionState, action: string, options: AnyRecord) {
  if (action === 'clear') {
    clearStoredRouteTimeline(state)
    await saveSessionState(state)
    emit({ message: '已清空 timeline' }, options)
    return
  }

  const payload = await withMiniProgram(state, async (miniProgram: AnyRecord) => {
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

async function handleLogs(state: SessionState, kind: string, action: string, options: AnyRecord) {
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

async function syncRouteTimelinePrelude(state: SessionState, options: AnyRecord, command: string) {
  if (!shouldEmitPreludeNotices(command)) {
    return
  }

  if (command === 'open' || command === 'connect' || command === 'close' || command === 'app' || command === 'doctor' || command === 'protocol' || command === 'devtools') {
    return
  }

  if (!state.config || !String(state.config.projectPath || '').trim()) {
    return
  }

  const payload = await withMiniProgram(state, async (miniProgram: AnyRecord) => {
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

async function handleCall(state: SessionState, target: string, method: string, args: string[], options: AnyRecord) {
  if (!target || !method) {
    throw new Error('call requires target and method, e.g. call wx getSystemInfoSync')
  }

  const payload = await withMiniProgram(state, async (miniProgram: AnyRecord) => {
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

async function handleScreenshot(state: SessionState, outputPath: string, options: AnyRecord) {
  const awaitCondition = resolveExplicitAwaitCondition(options.await, 'screenshot', options)
  const payload = await withMiniProgram(state, async (miniProgram: AnyRecord) => {
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
      return collectRecordRects(page, snapshot.records, await (miniProgram.systemInfo as () => Promise<AnyRecord>)())
    }

    if (mode === 'visual') {
      const result = await captureVisualScreenshot({
        miniProgram,
        targetPath: name,
        config: state.config,
        timeoutMs,
        pageCapture: async (targetPath: string, timeoutMs: number) => {
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
      const refs = await collectRecordRects(page, snapshot.records, await (miniProgram.systemInfo as () => Promise<AnyRecord>)())
      const result = await captureAnnotatedScreenshot({
        miniProgram,
        targetPath: name,
        config: state.config,
        refs,
        focusRefs,
        noRef: Boolean(options.noRef),
        timeoutMs,
        pageCapture: async (targetPath: string) => targetPath,
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
      const systemInfo = await (miniProgram.systemInfo as () => Promise<AnyRecord>)()
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

async function handleClose(state: SessionState, options: AnyRecord) {
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

async function dispatch(state: SessionState, positional: string[], options: AnyRecord, context: AnyRecord = {}) {
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
      await handleSnapshot(state, options, (context.scopeRef as string | null) || null)
      return
    case 'query':
      await handleQuery(state, rest[0], rest.slice(1).join(' '), options, (context.scopeRef as string | null) || null)
      return
    case 'await':
      await handleAwaitCommand(state, rest[0], options, (context.scopeRef as string | null) || null)
      return
    case 'within':
      await dispatch(state, rest.slice(1), options, { scopeRef: rest[0] })
      return
    case 'tap':
    case 'click':
      await handleTap(state, rest[0], options, (context.scopeRef as string | null) || null)
      return
    case 'input':
    case 'fill':
      await handleInput(state, rest[0], rest.slice(1).join(' '), options, (context.scopeRef as string | null) || null)
      return
    case 'wait':
      await handleWait(state, rest[0], options, (context.scopeRef as string | null) || null)
      return
    case 'get':
      await handleGet(state, rest[0], rest[1], rest[2], options, (context.scopeRef as string | null) || null)
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

function wantsJsonOutput(argv: string[]) {
  return argv.includes('--json')
}

function shouldAcquireRuntimeLock(command: string, state: SessionState) {
  if (command === undefined || command === 'help' || command === 'session' || command === 'open' || command === 'connect') {
    return false
  }
  return Boolean(runtimeLockName(state && state.config))
}

function buildCliErrorPayload(error: AnyRecord) {
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
    } as AnyRecord,
  }
  const payloadError = payload.error as AnyRecord
  if (code) {
    payloadError.code = code
  }
  if (hint) {
    payloadError.hint = hint
  }
  if (log) {
    payloadError.log = log
  }
  if (next) {
    payloadError.next = next
  }
  if (raw) {
    payloadError.raw = raw
  }
  if (diagnostics) {
    payloadError.diagnostics = diagnostics
  }
  return payload
}

function emitCliError(error: AnyRecord, json: boolean) {
  const message = error && error.message ? String(error.message) : String(error || 'Unknown error')

  if (json) {
    console.log(JSON.stringify(buildCliErrorPayload(error), null, 2))
    return
  }

  console.error(message)
  if (error && error.hint) {
    const hint = String(error.hint).trim()
    if (hint && hint !== message.trim()) {
      console.error(hint)
    }
  }
  if (error && error.raw) {
    const raw = String(error.raw).trim()
    // 人话 message 与底层原文不同时，额外打印 raw 摘录，避免盖掉 DevTools/CLI 真因
    // 同时截断 --debug 洪水（完整 raw 仍在 JSON / error.raw 字段）
    if (raw && raw !== message.trim()) {
      console.error(summarizeDevtoolsCliRaw(raw, { maxLines: 20 }))
    }
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
      // session 文件不落 autoPort；从 runtime 池回绑后才能抢 runtime 锁（close 不要求 endpoint live）
      await bindSessionRuntimeFromPool(targetState, { requireLive: false })
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

  const resolvedOptions = await ensureImplicitSessionName(scopedOptions, command)
  if (!resolvedOptions.session) {
    throw new Error(
      '无法解析 session：请在小程序项目目录执行，或传 --project <小程序根>；也可显式传 --session <name>。CLI 会按项目自动生成/复用 {project}-xN。',
    )
  }

  const lockConfig = await resolveSessionConfig(
    resolvedOptions.session,
    mergeConfigOverrides(baseConfig, buildExplicitOverrides(resolvedOptions)),
  )
  const lock = await acquireSessionLock(resolvedOptions.session, lockConfig, { command })

  let runtimeLock = null
  try {
    const state = await resolveSession(resolvedOptions)
    if (shouldAcquireRuntimeLock(command, state)) {
      runtimeLock = await acquireSessionLock(runtimeLockName(state.config), state.config, { command: `runtime ${command}` })
    }
    await syncRouteTimelinePrelude(state, resolvedOptions, command)
    await dispatch(state, positional, resolvedOptions)
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
