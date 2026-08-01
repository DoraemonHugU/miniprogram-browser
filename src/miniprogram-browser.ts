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
  allocateTempScreenshotPath,
} = require('./lib/temp-artifacts')

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
  getActiveSession,
  setActiveSession,
  reconcileRuntimeLaunches,
  isEphemeralNoiseSessionName,
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
  projectSessionSlug,
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
  discoverLiveAutomationPort,
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
 * 省略 --session 时：优先使用环境/项目活动 session，再按项目生成/复用 {slug}-xN。
 * - 默认复用已有最大序号自动 session
 * - open --fresh 且未显式 session 时分配下一个 xN
 * - MINIPROGRAM_BROWSER_SESSION 是显式的 Agent/工作树默认值
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
  const allocateFresh = (command === 'open' || command === 'connect') && Boolean(options.fresh)
  const envSession = String(process.env.MINIPROGRAM_BROWSER_SESSION || '').trim()
  if (!allocateFresh && envSession && envSession !== 'default') {
    return {
      ...options,
      session: envSession,
      sessionProvided: false,
      sessionSelectionSource: 'env',
    }
  }

  const activeSession = await getActiveSession({
    ...baseConfig,
    projectPath,
  })
  if (!allocateFresh && activeSession && activeSession.sessionName) {
    return {
      ...options,
      session: activeSession.sessionName,
      sessionProvided: false,
      sessionSelectionSource: 'active',
    }
  }

  const states = await listSessionStates({
    ...baseConfig,
    projectPath,
  })
  const existingNames = states.map((item: AnyRecord) => String(item.name || '')).filter(Boolean)

  const sessionName = allocateFresh
    ? nextAutoProjectSessionName(existingNames, projectPath)
    : pickAutoProjectSessionName(existingNames, projectPath)

  return {
    ...options,
    session: sessionName,
    sessionProvided: false,
    sessionAutoAssigned: true,
    sessionSelectionSource: 'auto',
  }
}

async function resolveSession(options: AnyRecord, resolveOpts: { allocatePorts?: boolean } = {}) {
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
    await bindSessionRuntimeFromPool(state, {
      preferSessionName: Boolean(
        options.sessionProvided
        || options.sessionSelectionSource === 'active'
        || options.sessionSelectionSource === 'env',
      ),
    })
  }

  // open/connect/doctor 才允许分配新 autoPort；path/snapshot 等只回绑，避免「假端口 9517 不可用」误导
  const allocatePorts = resolveOpts.allocatePorts !== false
  if (allocatePorts || explicitOverrides.autoPort || String((state.config as AnyRecord).autoPort || '').trim()) {
    if (allocatePorts) {
      await ensureSessionPorts(state)
    } else {
      // 已有 port（显式或回绑）只做规范化，不新分配
      const stateConfig = state.config as AnyRecord
      stateConfig.autoPort = String(stateConfig.autoPort || '').trim()
      stateConfig.devtoolsPort = String(stateConfig.devtoolsPort || '').trim()
      state.portResolution = { autoPortAssigned: false, devtoolsPortAssigned: false }
    }
  } else {
    state.portResolution = { autoPortAssigned: false, devtoolsPortAssigned: false }
  }
  return state
}

/**
 * 从 RuntimeLaunchRecord 池为当前 session 回绑 autoPort（瞬态，不写回 session 文件）。
 * 优先匹配同 sessionName 的 live launch；否则同项目唯一 live autoPort。
 * 探测失败的 launch 标记为 stale，继续尝试同 session 的其他候选。
 */
async function bindSessionRuntimeFromPool(
  state: SessionState,
  options: { requireLive?: boolean; preferSessionName?: boolean } = {},
): Promise<boolean> {
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
  const preferred = options.preferSessionName === false ? '' : String(state.name || '').trim()
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

  // 同 sessionName 优先
  const own = preferred
    ? candidates.filter((item: AnyRecord) => String(item.sessionName || '').trim() === preferred)
    : []
  let tryList: AnyRecord[] = own
  if (tryList.length === 0) {
    // 无同名：按 autoPort 去重后仅允许唯一 live runtime
    const byPort = new Map<string, AnyRecord>()
    for (const item of candidates) {
      const port = String(item.autoPort || '').trim()
      if (!port || byPort.has(port)) {
        continue
      }
      byPort.set(port, item)
    }
    tryList = byPort.size === 1 ? [...byPort.values()] : []
  }

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

async function countOtherLiveRuntimesInProject(state: SessionState): Promise<number> {
  const projectPath = path.resolve(String(state.config.projectPath || ''))
  if (!projectPath) {
    return 0
  }
  const launches = await listRuntimeLaunches({ ...state.config, projectPath })
  let liveCount = 0
  for (const launch of launches) {
    if (!launch || !launch.autoPort) {
      continue
    }
    if (state.runtimeLaunchId && String(launch.id || '') === String(state.runtimeLaunchId)) {
      continue
    }
    if (launch.projectPath && path.resolve(String(launch.projectPath)) !== projectPath) {
      continue
    }
    const live = await isAutomationEndpointLive(
      { ...state.config, autoPort: launch.autoPort },
      { timeoutMs: 800 },
    ).catch(() => false)
    if (live) {
      liveCount += 1
    }
  }
  return liveCount
}

async function cleanupStartedOpenRuntime(state: SessionState) {
  // 本 port 已 live：说明 automation 实际起来了，禁止 close/清 session（用户无需再 open）
  if (await isStateAutoPortLive(state, 1200)) {
    const cleanup = {
      projectClosed: false,
      closeVerified: false,
      closeAttempted: false,
      skippedCloseReason: 'own-auto-port-live',
      sessionCleared: false,
    } as unknown as AnyRecord
    if (state.runtimeLaunchId) {
      cleanup.runtimeLaunchId = state.runtimeLaunchId
      await markStartedRuntimeLaunch(state, {
        status: 'live',
        autoPort: state.config.autoPort,
        cleanup,
      }).catch(() => null)
    } else {
      await ensureLiveRuntimeLaunch(state, {
        autoPort: state.config.autoPort,
        devtoolsPort: state.config.devtoolsPort,
      }).catch(() => null)
    }
    await saveSessionState(state).catch(() => null)
    return cleanup
  }

  const sharedLive = await countOtherLiveRuntimesInProject(state).catch(() => 0)
  if (sharedLive > 0) {
    const cleanup = {
      projectClosed: false,
      closeVerified: false,
      closeAttempted: false,
      skippedCloseReason: 'shared-live-runtime',
      sharedLiveCount: sharedLive,
      sessionCleared: false,
    } as unknown as AnyRecord
    if (state.runtimeLaunchId) {
      cleanup.runtimeLaunchId = state.runtimeLaunchId
      await markStartedRuntimeLaunch(state, {
        status: 'stale',
        cleanup,
      }).catch(() => null)
    }
    // 保留 session 文件，便于用户 session list 后再次 open attach
    return cleanup
  }

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

  const launches = await listRuntimeLaunches({ ...state.config, projectPath: state.config.projectPath })

  // 仅当 runtimeLaunchId 确实属于当前 session 时才原地 update。
  // 附着 owner runtime 时 id 指向他人 launch，绝不能改写 owner 行。
  if (state.runtimeLaunchId) {
    const owned = launches.find((item: AnyRecord) => (
      item
      && String(item.id || '') === String(state.runtimeLaunchId)
      && String(item.sessionName || '').trim() === state.name
    ))
    if (owned) {
      const updated = await updateRuntimeLaunch(state.runtimeLaunchId, state.config, patch).catch(() => null)
      if (updated) {
        state.runtimeLaunchStatus = 'live'
        return updated
      }
    } else {
      state.runtimeLaunchId = null
    }
  }

  // 尝试复用同 session + 同 autoPort 的已有记录
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
    const refreshed = await listRuntimeLaunches({ ...state.config, projectPath: state.config.projectPath })
    for (const item of refreshed) {
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
  if (
    openError
    && !openError.code
    && /冷启动未完成|automation 在超时前未在 autoPort=|open timed out after/iu.test(String(openError.message || ''))
  ) {
    const timeoutError = createOpenTimeoutError(resolveOpenTimeoutMs(options))
    openError.code = timeoutError.code
    if (/open timed out after/iu.test(String(openError.message || ''))) {
      openError.message = timeoutError.message
    }
    if (!openError.hint) {
      openError.hint = timeoutError.hint
    }
  }
  const failureContext = await buildOpenFailureDiagnostics(state, options).catch(() => undefined)
  // OPEN_TIMEOUT 是 open 路径的硬结果，禁止被陈旧 WeappLog（如 cli-server-start-error）盖掉
  if (failureContext && failureContext.code && !openError.code) {
    openError.code = failureContext.code
  }
  if (failureContext && failureContext.diagnostics) {
    openError.diagnostics = failureContext.diagnostics
  }
  if (failureContext && failureContext.startupIssueCode) {
    openError.startupIssueCode = failureContext.startupIssueCode
  }
  if (!openError.code && openError.runtimeNotReady) {
    openError.code = 'APP_NOT_READY'
  }
  if (failureContext && failureContext.hint && (!openError.hint || openError.hint === genericTimeoutHint)) {
    openError.hint = failureContext.hint
  }
  if (
    failureContext
    && (failureContext.startupIssueCode === 'DEVTOOLS_LOGIN_REQUIRED'
      || failureContext.startupIssueCode === 'DEVTOOLS_PLUGIN_MISSING')
    && failureContext.message
    && openError.code === 'OPEN_TIMEOUT'
  ) {
    openError.message = failureContext.message
    openError.next = failureContext.startupIssueCode === 'DEVTOOLS_PLUGIN_MISSING'
      ? 'repair-devtools-plugin'
      : 're-login-devtools'
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

/**
 * open 连接阶段：只负责 withOpenTimeout + 错误 enrich。
 * cleanup 延后到 handleOpen 在「自愈失败」之后执行，避免拆掉已 live 的 port。
 */
async function openSessionWithDiagnostics(
  state: SessionState,
  options: AnyRecord,
  openOptions: AnyRecord = {},
  timeoutMs?: number,
) {
  const budgetMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Number(timeoutMs)
    : resolveOpenTimeoutMs(options)
  try {
    return await withOpenTimeout(
      () => connectOpenSession(state, { ...options, timeout: budgetMs }, openOptions),
      budgetMs,
    )
  } catch (error: unknown) {
    const openError = await enrichOpenFailure(error as AnyRecord, state, options)
    openError.needsStartedCleanup = shouldCleanupStartedOpenRuntime(state, openOptions, openError)
    throw openError
  }
}

async function isStateAutoPortLive(state: SessionState, timeoutMs = 1500): Promise<boolean> {
  const autoPort = String((state.config as AnyRecord).autoPort || '').trim()
  if (!autoPort) {
    return false
  }
  return await isAutomationEndpointLive(
    { ...state.config, autoPort },
    { timeoutMs },
  ).catch(() => false)
}

/**
 * 冷启动失败自愈（工具包揽，用户无需二次 open）：
 * 1) 本 autoPort 已 live → connect-only 成功
 * 2) 同项目其它 live → attach
 */
async function tryHealOpenAfterStartFailure(state: SessionState, options: AnyRecord, previousError: AnyRecord) {
  const previousMessage = previousError && previousError.message
    ? String(previousError.message).slice(0, 240)
    : undefined

  // 1) 同 port 已 live：enable 实际已成功，仅 connect 阶段失败/超时
  if (await isStateAutoPortLive(state, 2000)) {
    try {
      const connected = await withOpenTimeout(
        () => connectOpenSession(state, options, {
          mode: 'connected',
          attachedTo: '',
        }),
        Math.min(30000, Math.max(8000, resolveOpenTimeoutMs(options))),
      )
      await ensureLiveRuntimeLaunch(state, {
        route: connected.path || '',
        autoPort: connected.autoPort || state.config.autoPort,
        devtoolsPort: connected.devtoolsPort || state.config.devtoolsPort,
      })
      await saveSessionState(state)
      connected.rescuedFromStartFailure = true
      connected.healedSamePort = true
      connected.previousStartError = previousMessage
      emitOpenResult(connected, options)
      return connected
    } catch (_) {
      // 同 port 仍连不上，继续尝试其它 live
    }
  }

  // 2) 同项目其它 live runtime
  const attachResult = await resolveAttachableRuntime(state, options)
  if (attachResult.mode === 'attach' && attachResult.session) {
    const sessionInfo = attachResult.session as AnyRecord
    const autoPort = String(sessionInfo.autoPort || '').trim()
    if (autoPort) {
      const ownPort = String((state.config as AnyRecord).autoPort || '').trim()
      if (autoPort !== ownPort) {
        const live = await isAutomationEndpointLive(
          { ...state.config, autoPort },
          { timeoutMs: 1500 },
        ).catch(() => false)
        if (live) {
          ;(state.config as AnyRecord).autoPort = autoPort
          if (sessionInfo.devtoolsPort) {
            ;(state.config as AnyRecord).devtoolsPort = String(sessionInfo.devtoolsPort)
          }
          state.runtimeAttached = true
          state.runtimeOwnerSession = String(sessionInfo.name || sessionInfo.sessionName || '')
          await saveSessionState(state)
          try {
            const attached = await withOpenTimeout(
              () => connectOpenSession(state, options, {
                mode: 'attached',
                attachedTo: state.runtimeOwnerSession || '',
              }),
              Math.min(30000, Math.max(8000, resolveOpenTimeoutMs(options))),
            )
            await ensureLiveRuntimeLaunch(state, {
              route: attached.path || '',
              autoPort: attached.autoPort || state.config.autoPort,
              devtoolsPort: attached.devtoolsPort || state.config.devtoolsPort,
            })
            await saveSessionState(state)
            attached.rescuedFromStartFailure = true
            attached.previousStartError = previousMessage
            emitOpenResult(attached, options)
            return attached
          } catch (_) {
            // fall through to port scan
          }
        }
      }
    }
  }

  // 3) 扫描端口范围：auto 可能落在非指定 port
  const discovered = await discoverLiveAutomationPort(state.config, {
    preferredPort: String((state.config as AnyRecord).autoPort || ''),
    timeoutMs: 600,
    maxProbes: 35,
  }).catch(() => '')
  if (discovered) {
    ;(state.config as AnyRecord).autoPort = discovered
    try {
      const connected = await withOpenTimeout(
        () => connectOpenSession(state, options, {
          mode: 'connected',
          attachedTo: '',
        }),
        Math.min(30000, Math.max(8000, resolveOpenTimeoutMs(options))),
      )
      await ensureLiveRuntimeLaunch(state, {
        route: connected.path || '',
        autoPort: discovered,
        devtoolsPort: connected.devtoolsPort || state.config.devtoolsPort,
      })
      await saveSessionState(state)
      connected.rescuedFromStartFailure = true
      connected.healedDiscoveredPort = true
      connected.previousStartError = previousMessage
      emitOpenResult(connected, options)
      return connected
    } catch (_) {
      return null
    }
  }

  return null
}

async function handleOpen(state: SessionState, options: AnyRecord) {
  assertProjectPath(state.config)

  // 同项目 open 串行：避免双 auto；锁在 projectStateRoot/locks/__open_project__.lock
  const projectOpenLock = await acquireSessionLock('__open_project__', state.config, {
    command: 'open project',
    timeoutMs: Number(options.lockTimeoutMs || process.env.MINIPROGRAM_BROWSER_LOCK_TIMEOUT_MS || 180000),
  })
  try {
    const result = await handleOpenLocked(state, options)
    await setActiveSession(state.name, state.config)
    return result
  } finally {
    await releaseSessionLock(projectOpenLock)
  }
}

async function handleOpenLocked(state: SessionState, options: AnyRecord) {
  // 显式 --auto-port：若已 live 则直接 connected（同项目 attach 语义），避免 already-bound / 再 enable
  if (options.autoPort && !options.fresh) {
    const explicitLive = await isAutomationEndpointLive(state.config, { timeoutMs: 1500 }).catch(() => false)
    if (explicitLive) {
      await saveSessionState(state)
      const connected = await openSessionWithDiagnostics(state, options, {
        mode: state.runtimeAttached ? 'attached' : 'connected',
        attachedTo: state.runtimeOwnerSession || '',
      })
      await ensureLiveRuntimeLaunch(state, {
        route: connected.path || '',
        autoPort: connected.autoPort || state.config.autoPort,
        devtoolsPort: connected.devtoolsPort || state.config.devtoolsPort,
      })
      await saveSessionState(state)
      emitOpenResult(connected, options)
      return
    }
  }

  const currentEndpointLive = state.config.autoPort
    ? await isAutomationEndpointLive(state.config, { timeoutMs: 1000 }).catch(() => false)
    : false
  if (!currentEndpointLive && !options.fresh && !options.autoPort) {
    const attachResult = await resolveAttachableRuntime(state, options)
    if (attachResult.mode === 'ambiguous') {
      throw createMultipleLiveRuntimeError(state, attachResult.sessions || [], {
        command: 'open',
        selectionReason: options.sessionSelectionSource === 'active'
          ? `active-session-not-live:${state.name}`
          : 'no-active-session',
      })
    }
    if (attachResult.mode === 'attach' && attachResult.session) {
      const sessionInfo = attachResult.session as AnyRecord
      const autoPort = sessionInfo.autoPort as string | undefined
      if (autoPort) {
        ;(state.config as AnyRecord).autoPort = autoPort
      }
      const live = await isAutomationEndpointLive(state.config, { timeoutMs: 1000 }).catch(() => false)
      if (!live) {
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
    // 池无 live 记录，但本机已有 automation 在监听（上次 auto 迟到/手工启用）
    if (!String((state.config as AnyRecord).autoPort || '').trim()) {
      const orphanPort = await discoverLiveAutomationPort(state.config, {
        timeoutMs: 500,
        maxProbes: 30,
      }).catch(() => '')
      if (orphanPort) {
        ;(state.config as AnyRecord).autoPort = orphanPort
        await saveSessionState(state)
        const attached = await openSessionWithDiagnostics(state, options, {
          mode: 'attached',
          attachedTo: 'orphan-live',
        })
        await ensureLiveRuntimeLaunch(state, {
          route: attached.path || '',
          autoPort: attached.autoPort || orphanPort,
          devtoolsPort: attached.devtoolsPort || state.config.devtoolsPort,
        })
        await saveSessionState(state)
        emitOpenResult(attached, options)
        return
      }
    }
  }

  const openMode = currentEndpointLive ? (state.runtimeAttached ? 'attached' : 'connected') : 'started'
  const attemptedAutoPorts: string[] = []
  let result
  let lastOpenError: AnyRecord | null = null
  const totalTimeoutMs = resolveOpenTimeoutMs(options)
  const openDeadlineAt = Date.now() + totalTimeoutMs
  // 同一次 open 内最多 3 次 auto：预算切开，避免第 1 次吃光全部 timeout
  const perAttemptBudget = Math.max(
    25000,
    Math.floor(totalTimeoutMs / DEFAULT_OPEN_AUTO_PORT_ATTEMPTS),
  )

  for (let attempt = 1; attempt <= DEFAULT_OPEN_AUTO_PORT_ATTEMPTS; attempt += 1) {
    const remainingMs = Math.max(8000, openDeadlineAt - Date.now())
    const attemptTimeoutMs = Math.min(remainingMs, perAttemptBudget)
    if (openDeadlineAt - Date.now() < 5000 && attempt > 1) {
      break
    }

    if (openMode === 'started') {
      await recordStartedRuntimeLaunch(state, {
        attempt,
        autoPort: state.config.autoPort,
      })
    }
    await saveSessionState(state)

    try {
      if (attempt > 1) {
        emitProgress(`冷启动第 ${attempt}/${DEFAULT_OPEN_AUTO_PORT_ATTEMPTS} 次尝试（autoPort=${state.config.autoPort || '-'}）...`, options)
        await sleep(Math.min(3000, 1000 * attempt))
        const latePort = await discoverLiveAutomationPort(state.config, {
          preferredPort: String((state.config as AnyRecord).autoPort || ''),
          timeoutMs: 400,
          maxProbes: 50,
        }).catch(() => '')
        if (latePort) {
          ;(state.config as AnyRecord).autoPort = latePort
          result = await openSessionWithDiagnostics(state, options, {
            mode: 'connected',
            attachedTo: '',
          }, Math.min(attemptTimeoutMs, Math.max(8000, openDeadlineAt - Date.now())))
          result.rescuedFromStartFailure = true
          result.healedDiscoveredPort = true
          result.openAttempt = attempt
          break
        }
      }
      result = await openSessionWithDiagnostics(state, options, {
        mode: openMode,
        attachedTo: state.runtimeAttached ? state.runtimeOwnerSession : '',
      }, attemptTimeoutMs)
      if (attempt > 1) {
        result.openAttempt = attempt
      }
      break
    } catch (error: unknown) {
      const caughtError: AnyRecord = error as AnyRecord
      lastOpenError = caughtError
      attemptedAutoPorts.push(String(state.config.autoPort || ''))
      if (!shouldRetryOpenWithAnotherAutoPort(state, options, openMode, caughtError, attempt)) {
        caughtError.diagnostics = {
          ...((caughtError.diagnostics as AnyRecord) || {}),
          attemptedAutoPorts: attemptedAutoPorts.filter(Boolean),
        }
        if (openMode === 'started') {
          const healed = await tryHealOpenAfterStartFailure(state, options, caughtError).catch(() => null)
          if (healed) {
            return healed
          }
        }
        if (caughtError.needsStartedCleanup || shouldCleanupStartedOpenRuntime(state, { mode: openMode }, caughtError)) {
          const cleanup = await cleanupStartedOpenRuntime(state).catch((cleanupError) => ({
            projectClosed: false,
            closeAttempted: false,
            sessionCleared: false,
            error: cleanupError && cleanupError.message ? String(cleanupError.message) : String(cleanupError),
          }))
          caughtError.diagnostics = {
            ...((caughtError.diagnostics as AnyRecord) || {}),
            cleanup,
          }
        }
        throw caughtError
      }

      await reassignOpenAutoPort(state, attemptedAutoPorts)
    }
  }

  if (!result) {
    if (lastOpenError) {
      lastOpenError.diagnostics = {
        ...((lastOpenError.diagnostics as AnyRecord) || {}),
        attemptedAutoPorts: attemptedAutoPorts.filter(Boolean),
      }
      if (openMode === 'started') {
        const healed = await tryHealOpenAfterStartFailure(state, options, lastOpenError).catch(() => null)
        if (healed) {
          return healed
        }
      }
      throw lastOpenError
    }
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
  // 真登录/资源枯竭：换 port 无意义
  if (code === 'WINDOWS_SOCKET_EXHAUSTED') {
    return false
  }
  if (['DEVTOOLS_LOGIN_REQUIRED', 'DEVTOOLS_PLUGIN_MISSING'].includes(String(error.startupIssueCode || ''))) {
    return false
  }
  // 冷启动：指定 port 未 live / 扫端口暂空 → 允许同一次 open 内换 port 再 auto
  if (code === 'OPEN_TIMEOUT' || code === 'AUTOMATION_CONNECT_TIMEOUT' || code === 'DEVTOOLS_AUTOMATION_SERVER_FAILED') {
    return true
  }

  const message = String(error.message || '')
  if (/冷启动未完成|未发现可用 automation|WebSocket 尚不可连|Failed connecting to ws:\/\/127\.0\.0\.1:/iu.test(message)) {
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
        emitProgress('正在启用 DevTools 自动化（devtools auto）...', options)
        return
      }
      if (phase === 'wait-live') {
        emitProgress('正在等待 automation 端口就绪（冷启动常见，请稍候）...', options)
        return
      }
      if (phase === 'discover-port') {
        emitProgress('指定端口未就绪，正在扫描本机其它 automation 端口...', options)
        return
      }
      if (phase === 'connect') {
        emitProgress('正在连接小程序实例...', options)
      }
    },
  })
}

function emitOpenResult(result: AnyRecord, options: AnyRecord) {
  const pathLabel = result.path || (result.appReady === false ? '(warming up)' : '(no page)')
  const sessionName = options.session || ''
  const mode = String(result.mode || 'connected')
  const sessionSelectionSource = String(
    options.sessionProvided ? 'explicit' : (options.sessionSelectionSource || 'auto'),
  )
  // 文本首行：人/agent 先扫 mode/session/path/autoPort；细节仍在 JSON 字段
  const parts = [
    `已连接 mode=${mode}`,
    `path=${pathLabel}`,
    sessionName ? `session=${sessionName}` : '',
    options.sessionAutoAssigned ? '(auto-session)' : '',
    `sessionSource=${sessionSelectionSource}`,
    result.attachedTo ? `attachedTo=${result.attachedTo}` : '',
    result.rescuedFromStartFailure ? 'rescued=1' : '',
    `autoPort=${result.autoPort || '-'}`,
    result.autoPortAssigned ? '(auto-port)' : '',
    `project=${result.projectPath || '-'}`,
    result.appReady === false ? 'appReady=false' : '',
    result.stableTimeout ? 'stable=false' : '',
  ].filter(Boolean)
  emit({
    message: parts.join(' '),
    mode: result.mode,
    attachedTo: result.attachedTo,
    rescuedFromStartFailure: result.rescuedFromStartFailure || undefined,
    appReady: result.appReady,
    path: result.path,
    session: options.session || undefined,
    sessionSelectionSource,
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

async function resolveAttachableRuntime(state: SessionState, options: AnyRecord = {}) {
  const projectPath = path.resolve(state.config.projectPath || '')
  if (!projectPath) {
    return { mode: 'none', sessions: [] }
  }

  // 先清理僵尸 starting，避免池里假「进行中」干扰 attach 与观测
  await reconcileRuntimeLaunches({ ...state.config, projectPath }).catch(() => ({ markedStale: 0 }))

  // RuntimeLaunchRecord 管理 DevTools 窗口连接信息，session 不再固化 autoPort
  const launches = await listRuntimeLaunches({ ...state.config, projectPath })
  // 仅 live（starting 已 reconcile 或探测失败会变 stale）
  const candidateLaunches = launches.filter((item: AnyRecord) => {
    if (!item || !item.autoPort) {
      return false
    }
    if (item.projectPath && path.resolve(item.projectPath) !== projectPath) {
      return false
    }
    const status = String(item.status || '')
    // 仍允许「年轻」starting：可能刚写入尚未 mark live
    return status === 'live' || status === 'starting'
  })

  // 同 autoPort 只探测一次
  const portProbe = new Map<string, boolean>()
  const sameProjectLaunches: AnyRecord[] = []
  for (const launch of candidateLaunches) {
    const port = String(launch.autoPort || '').trim()
    if (!port) {
      continue
    }
    let live = portProbe.get(port)
    if (live === undefined) {
      const probed = await isAutomationEndpointLive({ ...state.config, autoPort: port }, { timeoutMs: 1000 }).catch(() => false)
      live = Boolean(probed)
      portProbe.set(port, live)
      // 探测失败的 starting 立刻标 stale（不必等 3 分钟）
      if (!live && String(launch.status || '') === 'starting' && launch.id) {
        await updateRuntimeLaunch(launch.id, state.config, { status: 'stale' }).catch(() => null)
      }
    }
    sameProjectLaunches.push({
      ...launch,
      status: live ? 'live' : 'stale',
    })
  }

  // 同 sessionName 优先；否则同项目唯一 live autoPort
  const attachableSessions = sameProjectLaunches.map((item: AnyRecord) => ({
    name: item.sessionName || '',
    projectPath: item.projectPath || '',
    autoPort: item.autoPort || '',
    devtoolsPort: item.devtoolsPort || '',
    status: item.status || 'stale',
    route: item.route || '',
    createdAt: item.createdAt || '',
    updatedAt: item.updatedAt || '',
  }))
  const preferredSession = options.sessionProvided
    || options.sessionSelectionSource === 'active'
    || options.sessionSelectionSource === 'env'
    ? state.name
    : ''
  const selected = selectAttachableRuntimeSession(attachableSessions, preferredSession)
  if (selected.mode !== 'attach') {
    return selected
  }

  return {
    mode: 'attach',
    session: selected.session,
  }
}

function createMultipleLiveRuntimeError(state: SessionState, sessions: AnyRecord[], options: AnyRecord = {}) {
  const candidates = (sessions || []).map((item: AnyRecord) => ({
    name: String(item.name || item.sessionName || '').trim(),
    autoPort: String(item.autoPort || '').trim(),
    route: String(item.route || '').trim(),
    devtoolsPort: String(item.devtoolsPort || '').trim(),
  })).filter((item: AnyRecord) => item.name)
  const candidateLines = candidates.map((item: AnyRecord) => {
    const details = [
      item.route ? `route=${item.route}` : '',
      item.autoPort ? `autoPort=${item.autoPort}` : '',
    ].filter(Boolean).join(' ')
    return `  ${item.name}${details ? `  ${details}` : ''}`
  })
  const command = String(options.command || 'snapshot').trim()
  const nextCommands = candidates.map((item: AnyRecord) => `miniprogram-browser ${command} --session ${item.name}`)
  nextCommands.push('miniprogram-browser open --session new --fresh')
  const error = new Error([
    '当前项目存在多个 live runtime，无法安全判断目标。',
    '请显式使用 --session <name> 选择已有 runtime，或使用 --fresh 新开 runtime。',
    '可选 session:',
    ...candidateLines,
    '可直接执行:',
    ...nextCommands.map((item) => `  ${item}`),
  ].join('\n')) as unknown as AnyRecord
  error.code = 'MULTIPLE_LIVE_RUNTIMES'
  error.hint = '已有 runtime 不需要手动指定 autoPort；先用 session list 查看当前项目的 session。'
  error.next = 'session list'
  error.diagnostics = {
    projectPath: state.config.projectPath,
    selectionReason: options.selectionReason || 'no-unique-live-runtime',
    liveSameProjectRuntimes: candidates,
    nextCommands,
  }
  return error
}

function summarizeDevtoolsStartupHints(logPayload: AnyRecord) {
  const rules = [
    {
      code: 'login-expired',
      pattern: /INVALID_LOGIN|access_token\s*(?:expired|missing)|errcode\s*=\s*(?:41001|42001|42002)|需要重新登录|请先登录|not login|please login|code:\s*10\b/iu,
      message: 'DevTools 日志报告登录态失效（41001/42001/42002、access_token missing 或需要重新登录）；请在微信开发者工具中重新登录后再 open。',
    },
    {
      code: 'appid-missing',
      pattern: /appid missing|41002/iu,
      message: 'DevTools 日志报告 appid missing / 41002；请确认 DevTools 实际打开的项目配置中 AppID 被正确读取。',
    },
    {
      code: 'devtools-plugin-missing',
      pattern: /\[ideplugin\].*(?:manifest\.json|version).*not installed|ideplugin.*not installed/iu,
      message: 'DevTools automation 插件未安装或未加载（ideplugin manifest not installed）；请确认使用同一安装目录下的 DevTools CLI，重启或修复微信开发者工具后再 open。',
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
    if (normalizedCode === 'DEVTOOLS_LOGIN_REQUIRED') {
      return item.code === 'login-expired'
    }
    if (normalizedCode === 'DEVTOOLS_PLUGIN_MISSING') {
      return item.code === 'devtools-plugin-missing'
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
    if (normalizedCode === 'DEVTOOLS_LOGIN_REQUIRED') {
      return item.code === 'login-expired'
    }
    if (normalizedCode === 'DEVTOOLS_PLUGIN_MISSING') {
      return item.code === 'devtools-plugin-missing'
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
  if (/INVALID_LOGIN|access_token\s*(?:expired|missing)|errcode\s*=\s*(?:41001|42001|42002)|需要重新登录|请先登录|not login|please login|code:\s*10\b/iu.test(summaryLine)) {
    return {
      code: 'DEVTOOLS_LOGIN_REQUIRED',
      hint: 'devtoolsLog=login-expired',
    }
  }
  if ((hints || []).some((item) => item && item.code === 'devtools-plugin-missing')) {
    return {
      code: 'DEVTOOLS_PLUGIN_MISSING',
      hint: 'devtoolsLog=devtools-plugin-missing',
    }
  }
  if (/\[ideplugin\].*(?:manifest\.json|version).*not installed|ideplugin.*not installed/iu.test(summaryLine)) {
    return {
      code: 'DEVTOOLS_PLUGIN_MISSING',
      hint: 'devtoolsLog=devtools-plugin-missing',
    }
  }
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
  if (codes.has('login-expired')) {
    return {
      code: 'DEVTOOLS_LOGIN_REQUIRED',
      hint: 'devtoolsLog=login-expired',
    }
  }
  if (codes.has('devtools-plugin-missing')) {
    return {
      code: 'DEVTOOLS_PLUGIN_MISSING',
      hint: 'devtoolsLog=devtools-plugin-missing',
    }
  }
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
      grep: 'appid missing|41002|routeTo appLaunch timeout|triggerAppRouteDone timeout|start cli server error|ideplugin|manifest\.json.*not installed|10055|INVALID_LOGIN|access_token',
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

function countUniqueLiveRuntimePorts(liveSameProjectSessions: AnyRecord[] = []) {
  return new Set(
    (Array.isArray(liveSameProjectSessions) ? liveSameProjectSessions : [])
      .map((item: AnyRecord) => String(item && item.autoPort || '').trim())
      .filter(Boolean),
  ).size
}

/**
 * open 失败诊断用的 resolution 标签。
 * 端口仍由 CLI 自管；多个不同 live port 是 session 选择歧义，而不是让用户选择端口。
 */
function summarizeOpenResolution(options: AnyRecord, liveSameProjectSessions: AnyRecord[] = []) {
  const liveRuntimeCount = countUniqueLiveRuntimePorts(liveSameProjectSessions)
  if (liveRuntimeCount >= 1) {
    if (options && options.autoPort) {
      return 'attach-blocked-by-auto-port'
    }
    if (liveRuntimeCount > 1) {
      return 'ambiguous'
    }
    return 'attachable'
  }
  if (options && options.devtoolsPort) {
    return 'adopt-via-devtools-port'
  }
  return 'start-required'
}

/**
 * open 失败时给出下一步；多个 live runtime 时要求用 session 选择目标。
 */
function resolveOpenFailureNextAction(options: AnyRecord, liveSameProjectSessions: AnyRecord[] = []) {
  const liveRuntimeCount = countUniqueLiveRuntimePorts(liveSameProjectSessions)
  if (liveRuntimeCount < 1) {
    return ''
  }
  if (options && options.fresh) {
    return 'open without --fresh'
  }
  if (options && options.autoPort) {
    return 'open without --auto-port'
  }
  if (liveRuntimeCount > 1) {
    return 'session list; then use --session <name>'
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
  if (startupClassification) {
    diagnostics.startupIssueCode = startupClassification.code
  }

  const resolution = summarizeOpenResolution(options, liveSameProjectSessions)
  const adoptBootstrap = resolution === 'adopt-via-devtools-port'
  if (adoptBootstrap) {
    diagnostics.devtoolsReuseMode = 'adopt-bootstrap'
  }

  // 人话 hint：只放 resolution/strategy/autoPort；live 多实例细节只在 diagnostics JSON
  const facts = [
    startupClassification ? startupClassification.hint : '',
    adoptBootstrap ? 'mode=adopt-bootstrap' : '',
    `resolution=${resolution}`,
    `strategy=${automationArgs.projectStrategy}`,
    state.config.autoPort ? `autoPort=${state.config.autoPort}` : '',
  ].filter(Boolean)

  return {
    diagnostics,
    startupIssueCode: startupClassification ? startupClassification.code : undefined,
    message: startupClassification
      ? resolveStartupIssueMessage(startupHints, startupClassification.code)
      : undefined,
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

  // live-first：已有可用 automation 时只 probe，不重复 enable（避免扰动现网 + 陈旧日志误报）
  let automationMetadata: AnyRecord | null = null
  let automationError: AnyRecord | null = null
  let reusedLiveEndpoint = false
  const alreadyLive = await isAutomationEndpointLive(state.config, {
    timeoutMs: Math.min(2000, Number(options.timeout || 5000)),
  }).catch(() => false)

  if (alreadyLive) {
    reusedLiveEndpoint = true
    automationMetadata = {
      reusedLive: true,
      note: 'automation endpoint already live; skipped enableAutomation',
    }
  } else {
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
  }

  const probe = automationError
    ? null
    : await probeAutomationRuntime(state.config, {
      timeoutMs: Number(options.timeout || 5000),
      screenshot: Boolean(options.captureScreenshot),
    })

  // 已 live 且 probe 成功：不要再用历史 appid-missing 等日志覆盖 ok
  const shouldCollectStartupNoise = !automationError && probe && !probe.connected && !reusedLiveEndpoint
  const startupHints = shouldCollectStartupNoise
    ? await collectDevtoolsStartupHints(state)
    : []
  const doctorLogContext = shouldCollectStartupNoise
    ? await collectDevtoolsLogContext(state, 'error|fail|timeout|errcode|appid')
    : { log: '' }
  const startupClassification = shouldCollectStartupNoise
    ? classifyOpenFailureFromStartupHints(startupHints, {
      summaryLine: doctorLogContext.log,
    })
    : null
  const startupIssue = automationError
    ? null
    : (probe && probe.connected)
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
        reusedLive: reusedLiveEndpoint || undefined,
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
    lines.push(`automation=${(payload.automation as AnyRecord).ok ? 'ok' : 'failed'}${reusedLiveEndpoint ? ' (reused-live)' : ''}`)
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

  /**
   * 从 runtime 池解析 session 应展示/探测的 autoPort。
   * 优先级：session 自身字段 → 同 sessionName launch → 已记录的 owner launch → 同项目唯一 live launch。
   * 附着 session 往往没有自己的 launch 行，必须能回落到项目 live。
   *
   * attachedTo 规则（避免「owner 显示 attachedTo 自己」）：
   * - 已有 runtimeOwnerSession 则用之
   * - 有自身 launch 行 → 视为该 port 的 owner 侧记录，不填 attachedTo
   * - 仅当无自身 launch、port 来自他人时才填 attachedTo
   */
function resolveSessionRuntimeBinding(
  item: AnyRecord,
  launchIndex: Map<string, AnyRecord>,
  projectUniqueLive: AnyRecord | null,
): { autoPort: string; devtoolsPort: string; launch: AnyRecord | null; attachedTo: string } {
  const projectKey = path.resolve(String(item.projectPath || ''))
  const ownLaunch = launchIndex.get(`${item.name}::${projectKey}`) || null
  const ownerName = String(item.runtimeOwnerSession || '').trim()
  const ownerLaunch = ownerName
    ? (launchIndex.get(`${ownerName}::${projectKey}`) || null)
    : null

  let launch: AnyRecord | null = ownLaunch
  if (!launch && ownerLaunch && ownerLaunch.autoPort) {
    launch = ownerLaunch
  }
  if (!launch && projectUniqueLive && projectUniqueLive.autoPort) {
    launch = projectUniqueLive
  }

  const autoPort = String(item.autoPort || (launch && launch.autoPort) || '').trim()
  const devtoolsPort = String(item.devtoolsPort || (launch && launch.devtoolsPort) || '').trim()

  let attachedTo = ''
  if (ownerName && ownerName !== item.name) {
    attachedTo = ownerName
  } else if (!ownLaunch && launch && String(launch.sessionName || '').trim() && String(launch.sessionName) !== item.name) {
    // 无自身 launch：port 来自他人 → 附着
    attachedTo = String(launch.sessionName)
  }
  // 有自身 live launch 时不因「同 port 还有别人」而标 attachedTo

  return { autoPort, devtoolsPort, launch, attachedTo }
}

async function buildProjectLaunchIndexes(baseConfig: AnyRecord, projectPaths: string[]) {
  const launchIndex = new Map<string, AnyRecord>()
  const projectLiveLaunches = new Map<string, AnyRecord[]>()

  const uniqueProjects = [...new Set(projectPaths.map((p) => path.resolve(String(p || ''))).filter(Boolean))]
  for (const projectPath of uniqueProjects) {
    try {
      const launches = await listRuntimeLaunches({ ...baseConfig, projectPath })
      const liveRows: AnyRecord[] = []
      for (const launch of launches) {
        if (!launch || !launch.sessionName || !launch.autoPort) {
          continue
        }
        const key = `${String(launch.sessionName)}::${path.resolve(String(launch.projectPath || projectPath))}`
        const prev = launchIndex.get(key)
        if (!prev || String(launch.updatedAt || '') > String(prev.updatedAt || '')) {
          launchIndex.set(key, launch)
        }
        if (String(launch.status || '') === 'live') {
          liveRows.push(launch)
        }
      }
      projectLiveLaunches.set(projectPath, liveRows)
    } catch (_) {}
  }

  return { launchIndex, projectLiveLaunches }
}

function pickProjectUniqueLiveLaunch(liveRows: AnyRecord[] = []): AnyRecord | null {
  const byPort = new Map<string, AnyRecord>()
  for (const row of liveRows) {
    const port = String(row && row.autoPort || '').trim()
    if (!port) {
      continue
    }
    const prev = byPort.get(port)
    if (!prev || String(row.updatedAt || '') > String(prev.updatedAt || '')) {
      byPort.set(port, row)
    }
  }
  // 多 port 时无法唯一推断附着目标
  if (byPort.size !== 1) {
    return null
  }
  return [...byPort.values()][0]
}

async function buildSessionStatusEntries(options: AnyRecord = {}): Promise<{
  entries: AnyRecord[]
  projectFilter: string
  message: string
}> {
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
      message = '当前目录没有发现小程序项目；请传 --project <path>，或用 session list --all 查看全局 session。'
    }
  }

  const visibleSessions = projectFilter
    ? sessions.filter((item: AnyRecord) => path.resolve(item.projectPath || '') === projectFilter)
    : (options.all ? sessions : [])
  const projectPaths: string[] = [...new Set<string>(visibleSessions
    .map((item: AnyRecord) => path.resolve(String(item.projectPath || projectFilter || '')))
    .filter(Boolean))]
  const { launchIndex, projectLiveLaunches } = await buildProjectLaunchIndexes(baseConfig, projectPaths)
  const activeByProject = new Map<string, string>()
  for (const projectPath of projectPaths) {
    const active = await getActiveSession({ ...baseConfig, projectPath })
    if (active && active.sessionName) {
      activeByProject.set(projectPath, String(active.sessionName))
    }
  }

  const entries = await Promise.all(visibleSessions.map(async (item: AnyRecord) => {
    const projectKey = path.resolve(String(item.projectPath || ''))
    const liveRows = projectLiveLaunches.get(projectKey) || []
    const uniqueLive = pickProjectUniqueLiveLaunch(liveRows)
    const binding = resolveSessionRuntimeBinding(item, launchIndex, uniqueLive)
    const live = binding.autoPort
      ? await isAutomationEndpointLive({ ...baseConfig, autoPort: binding.autoPort }, { timeoutMs: 800 }).catch(() => false)
      : false
    const attachedTo = binding.attachedTo || String(item.runtimeOwnerSession || '').trim()
    const runtimeOwnerSession = attachedTo || (binding.autoPort ? item.name : '')
    return {
      session: item.name,
      active: activeByProject.get(projectKey) === item.name,
      status: live ? 'live' : 'stale',
      projectPath: item.projectPath || '',
      route: item.route || '',
      autoPort: binding.autoPort || item.autoPort || '',
      devtoolsPort: binding.devtoolsPort || item.devtoolsPort || '',
      runtime: binding.autoPort ? (attachedTo ? 'attached' : 'owner') : 'none',
      runtimeOwnerSession,
      attachedTo,
      createdAt: item.createdAt || '',
      updatedAt: item.updatedAt || '',
    }
  }))

  return { entries, projectFilter, message }
}

async function handleSessionInfo(options: AnyRecord = {}, requestedName = '') {
  const targetName = String(requestedName || options.session || '').trim()
  const result = await buildSessionStatusEntries(options)
  const candidates = result.entries.map((item: AnyRecord) => String(item.session || ''))
  const activeEntry = result.entries.find((item: AnyRecord) => item.active)
  const matching = targetName
    ? result.entries.filter((item: AnyRecord) => item.session === targetName)
    : (activeEntry ? [activeEntry] : [])

  if (matching.length !== 1) {
    const error = new Error(
      targetName
        ? `未找到 session "${targetName}"；请先用 session list 查看当前项目候选。`
        : '当前项目没有活动 session；请先执行 open --session <name>，或传 session info <name>。',
    ) as unknown as AnyRecord
    error.code = targetName ? 'SESSION_NOT_FOUND' : 'NO_ACTIVE_SESSION'
    error.hint = result.message || '先用 session list 查看当前项目 session。'
    error.next = 'session list'
    error.diagnostics = {
      projectPath: result.projectFilter || undefined,
      requestedSession: targetName || undefined,
      activeSession: activeEntry ? activeEntry.session : '',
      candidates,
    }
    throw error
  }

  const entry = matching[0]
  const payload: AnyRecord = {
    ...entry,
    selection: targetName ? 'explicit' : 'active',
  }
  const session = String(payload.session || '')
  const active = Boolean(payload.active)
  const status = String(payload.status || 'stale')
  const runtime = String(payload.runtime || 'none')
  const projectPath = String(payload.projectPath || '')
  const route = String(payload.route || '')
  const runtimeOwnerSession = String(payload.runtimeOwnerSession || '')
  const attachedTo = String(payload.attachedTo || '')
  const autoPort = String(payload.autoPort || '')
  const devtoolsPort = String(payload.devtoolsPort || '')
  const createdAt = String(payload.createdAt || '')
  const updatedAt = String(payload.updatedAt || '')
  if (options.json) {
    emit(payload, options)
    return
  }

  emit({
    lines: [
      `session=${session} active=${active ? 'true' : 'false'} status=${status} runtime=${runtime}`,
      `project=${projectPath || '-'} route=${route || '(no route)'}`,
      `owner=${runtimeOwnerSession || '-'} attachedTo=${attachedTo || '-'} autoPort=${autoPort || '-'} devtoolsPort=${devtoolsPort || '-'}`,
      `created=${createdAt || '-'} updated=${updatedAt || '-'} selection=${String(payload.selection || '')}`,
    ],
  }, options)
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
  let visibleSessions = projectFilter
    ? sessions.filter((item: AnyRecord) => path.resolve(item.projectPath || '') === projectFilter)
    : (options.all ? sessions : [])

  // 项目内先 reconcile 僵尸 starting，list 与 open 看到同一干净池
  if (projectFilter) {
    await reconcileRuntimeLaunches({ ...baseConfig, projectPath: projectFilter }).catch(() => ({ markedStale: 0 }))
  } else if (options.all) {
    const projectPaths = [...new Set(visibleSessions.map((s: AnyRecord) => path.resolve(String(s.projectPath || ''))).filter(Boolean))]
    for (const projectPath of projectPaths) {
      await reconcileRuntimeLaunches({ ...baseConfig, projectPath }).catch(() => ({ markedStale: 0 }))
    }
  }

  const { launchIndex, projectLiveLaunches } = await buildProjectLaunchIndexes(
    baseConfig,
    visibleSessions.map((item: AnyRecord) => String(item.projectPath || projectFilter || '')),
  )
  const activeByProject = new Map<string, string>()
  const listProjectPaths: string[] = [...new Set<string>(visibleSessions
    .map((item: AnyRecord) => path.resolve(String(item.projectPath || projectFilter || '')))
    .filter(Boolean))]
  for (const projectPath of listProjectPaths) {
    const active = await getActiveSession({ ...baseConfig, projectPath })
    if (active && active.sessionName) {
      activeByProject.set(projectPath, String(active.sessionName))
    }
  }

  let sessionsWithStatus = await Promise.all(visibleSessions.map(async (item: AnyRecord) => {
    const projectKey = path.resolve(String(item.projectPath || ''))
    const liveRows = projectLiveLaunches.get(projectKey) || []
    const uniqueLive = pickProjectUniqueLiveLaunch(liveRows)
    const binding = resolveSessionRuntimeBinding(item, launchIndex, uniqueLive)
    const live = binding.autoPort
      ? await isAutomationEndpointLive({ ...baseConfig, autoPort: binding.autoPort }, { timeoutMs: 800 }).catch(() => false)
      : false
    const runtimeAttached = Boolean(item.runtimeAttached) || Boolean(binding.attachedTo)
    return {
      ...item,
      active: activeByProject.get(projectKey) === item.name,
      autoPort: binding.autoPort || item.autoPort || '',
      devtoolsPort: binding.devtoolsPort || item.devtoolsPort || '',
      createdAt: item.createdAt || '',
      updatedAt: item.updatedAt || '',
      runtimeAttached,
      runtimeOwnerSession: binding.attachedTo || item.runtimeOwnerSession || '',
      attachedTo: binding.attachedTo || undefined,
      status: live ? 'live' : 'stale',
    }
  }))

  // 默认隐藏门禁/e2e 残留的 stale 噪音；--noise 看全量
  const showNoise = Boolean(options.noise)
  let hiddenNoise = 0
  if (!showNoise) {
    const before = sessionsWithStatus.length
    sessionsWithStatus = sessionsWithStatus.filter((item) => {
      if (item.status === 'live') {
        return true
      }
      // 有语义名的 stale（work / feat-a / project-xN）保留；gate/e2e/test 前缀且 stale 隐藏
      if (isEphemeralNoiseSessionName(String(item.name || ''))) {
        return false
      }
      return true
    })
    hiddenNoise = before - sessionsWithStatus.length
  }
  if (hiddenNoise > 0 && !message) {
    message = `已隐藏 ${hiddenNoise} 条门禁/测试残留 session；需要时加 --noise 查看，或 session prune 清理。`
  }

  if (options.json) {
    emit({
      sessions: sessionsWithStatus,
      ...(hiddenNoise ? { hiddenNoise } : {}),
      ...(message ? { message } : {}),
    }, options)
    return
  }

  if (!sessionsWithStatus.length) {
    emit({ message: message || '当前没有已保存的 session' }, options)
    return
  }

  emit({
    lines: [
      ...sessionsWithStatus.map((item) => {
        const project = item.projectPath || '(unbound)'
        const devtoolsProject = item.devtoolsProjectPath ? ` devtoolsProject=${item.devtoolsProjectPath}` : ''
        const route = item.route || '(no route)'
        const created = item.createdAt || '-'
        const attached = item.attachedTo ? ` attachedTo=${item.attachedTo}` : ''
        const active = item.active ? ' active=true' : ''
        return `${item.name}${active} status=${item.status} created=${created} project=${project}${devtoolsProject} devtoolsPort=${item.devtoolsPort || '-'} autoPort=${item.autoPort || '-'}${attached} route=${route}`
      }),
      ...(message ? [message] : []),
    ],
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
  // 与 session list 同一套 binding：附着 session 无自身 launch 时回落到项目 live，避免误 prune
  const { launchIndex, projectLiveLaunches } = await buildProjectLaunchIndexes(baseConfig, [projectFilter])
  const liveRows = projectLiveLaunches.get(path.resolve(projectFilter)) || []
  const uniqueLive = pickProjectUniqueLiveLaunch(liveRows)
  const sessionsWithStatus = await Promise.all(visibleSessions.map(async (item: AnyRecord) => {
    const binding = resolveSessionRuntimeBinding(item, launchIndex, uniqueLive)
    const live = binding.autoPort
      ? await isAutomationEndpointLive({ ...baseConfig, autoPort: binding.autoPort }, { timeoutMs: 800 }).catch(() => false)
      : false
    return {
      ...item,
      autoPort: binding.autoPort || item.autoPort || '',
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
  const followup = options.follow ? await collectFollowupSnapshot(state, options) : null
  await saveSessionState(state)
  emit(attachFollowupPayload(payload, followup), options)
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
      const visualProbePath = await allocateTempScreenshotPath({
        directory: state.config.tempScreenshotDir,
        projectName: projectSessionSlug(state.config.projectPath),
        sessionName: state.name,
        route: page.path,
        mode: 'visual-probe',
      })
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

async function collectFollowupSnapshot(state: SessionState, options: AnyRecord): Promise<AnyRecord> {
  const snapshot = await withMiniProgram(state, async (miniProgram: AnyRecord) => {
    const page = await getCurrentPage(miniProgram)
    const result = await snapshotInteractive(page, state, null, {
      compact: Boolean(options.compact),
      depth: options.depth === undefined ? undefined : Number(options.depth),
    })
    Object.assign(state, result.state)
    return {
      path: page.path,
      records: result.records,
      lines: result.lines,
    }
  })

  return summarizeSnapshotPayload({
    state: { route: snapshot.path },
    records: snapshot.records,
    lines: snapshot.lines,
  }, options)
}

function attachFollowupPayload(payload: AnyRecord, followup: AnyRecord | null): AnyRecord {
  if (!followup) {
    return payload
  }

  const message = `${payload.message || '操作完成'}；已刷新 snapshot route=${followup.route || payload.path || '-'} count=${followup.count || 0}`
  return {
    ...payload,
    message,
    followup,
    // 文本模式优先打印新的 refs；JSON 模式同时保留结构化 followup 字段。
    lines: [message, ...(Array.isArray(followup.lines) ? followup.lines : [])],
  }
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
  const followup = options.follow ? await collectFollowupSnapshot(state, options) : null
  await saveSessionState(state)
  emit(attachFollowupPayload(payload, followup), options)
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
  const followup = options.follow ? await collectFollowupSnapshot(state, options) : null
  await saveSessionState(state)
  emit(attachFollowupPayload(payload, followup), options)
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
    let name: string
    if (outputPath) {
      name = path.isAbsolute(outputPath)
        ? outputPath
        : path.join(process.cwd(), outputPath)
    } else {
      const currentPage = await getCurrentPage(miniProgram).catch(() => null)
      const currentRoute = String((currentPage && currentPage.path) || state.route || 'unknown')
      if (currentRoute && currentRoute !== 'unknown') {
        state.route = currentRoute
      }
      name = await allocateTempScreenshotPath({
        directory: state.config.tempScreenshotDir,
        projectName: projectSessionSlug(state.config.projectPath),
        sessionName: state.name,
        route: currentRoute,
        mode,
      })
    }

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

  if (command === 'session' && (positional[1] === 'info' || positional[1] === 'status')) {
    await handleSessionInfo(scopedOptions, positional[2])
    return
  }

  if (command === 'status') {
    await handleSessionInfo(scopedOptions, positional[1])
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
    // 仅 open/connect/doctor 需要分配新 autoPort；其它命令只从 runtime 池回绑
    const allocatePorts = command === 'open' || command === 'connect' || command === 'doctor'
    const state = await resolveSession(resolvedOptions, { allocatePorts })
    if (
      !resolvedOptions.sessionProvided
      && !resolvedOptions.autoPort
      && command !== 'open'
      && command !== 'connect'
      && command !== 'doctor'
    ) {
      const runtimeSelection = await resolveAttachableRuntime(state, resolvedOptions)
      if (runtimeSelection.mode === 'ambiguous') {
        throw createMultipleLiveRuntimeError(state, runtimeSelection.sessions || [], {
          command,
          selectionReason: resolvedOptions.sessionSelectionSource === 'active'
            ? `active-session-not-live:${state.name}`
            : resolvedOptions.sessionSelectionSource === 'env'
              ? `env-session-not-live:${state.name}`
              : 'no-active-session',
        })
      }
    }
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
  enrichOpenFailure,
  tryHealOpenAfterStartFailure,
  cleanupStartedOpenRuntime,
  classifyOpenFailureFromStartupHints,
  summarizeDevtoolsStartupHints,
  summarizeOpenResolution,
  createMultipleLiveRuntimeError,
  ensureImplicitSessionName,
  buildSessionStatusEntries,
  handleSessionInfo,
  attachFollowupPayload,
  shouldClearFailedOpenSession,
  shouldAttemptVisualProbe,
  shouldEmitPreludeNotices,
  summarizeTimelinePayload,
  summarizeSnapshotPayload,
}
