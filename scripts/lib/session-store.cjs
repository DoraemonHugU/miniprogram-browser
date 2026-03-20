const { existsSync } = require('node:fs')
const { mkdir, readdir, readFile, rm, stat, writeFile } = require('node:fs/promises')
const { createHash } = require('node:crypto')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

const DEVTOOLS_PORT_RANGE = { start: 39085, end: 39185 }
const AUTO_PORT_RANGE = { start: 9421, end: 9521 }
const DEFAULT_MAX_INACTIVE_REFS = 200
const DEFAULT_MAX_RUNTIME_EVENTS = 200
const DEFAULT_MAX_ROUTE_EVENTS = 200

function detectRepoRoot() {
  return path.resolve(__dirname, '../..')
}

function createDefaultConfig(repoRoot = detectRepoRoot()) {
  const merged = { ...process.env }

  let defaultCliPath = ''
  if (process.platform === 'darwin') {
    defaultCliPath = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli'
  } else if (process.platform === 'win32') {
    defaultCliPath = 'C:\\Program Files (x86)\\Tencent\\微信web开发者工具\\cli.bat'
  }

  return {
    repoRoot,
    cliPath: merged.WECHAT_DEVTOOLS_CLI || defaultCliPath,
    devtoolsPort: merged.WECHAT_DEVTOOLS_PORT ? String(merged.WECHAT_DEVTOOLS_PORT) : '',
    autoPort: merged.WECHAT_AUTO_PORT ? String(merged.WECHAT_AUTO_PORT) : '',
    projectPath: '',
    sessionDir: path.join(repoRoot, '.memory/miniprogram-browser/sessions'),
    screenshotDir: path.join(repoRoot, 'artifacts/screenshots'),
    tempScreenshotDir: path.join(os.tmpdir(), 'miniprogram-browser'),
  }
}

function assertProjectPath(config) {
  if (!config || !String(config.projectPath || '').trim()) {
    throw new Error('Missing project path. Pass --project <miniprogram-root> on first open/session binding.')
  }
}

function mergeConfigOverrides(baseConfig, overrides = {}) {
  const merged = { ...(baseConfig || {}) }

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || value === null || value === '') {
      continue
    }
    merged[key] = value
  }

  return merged
}

function assertBindingConsistency(existingConfig, overrides = {}) {
  const keys = ['projectPath', 'devtoolsPort', 'autoPort']

  for (const key of keys) {
    const existingValue = String((existingConfig && existingConfig[key]) || '').trim()
    const overrideValue = String((overrides && overrides[key]) || '').trim()

    if (!existingValue || !overrideValue) {
      continue
    }

    if (existingValue !== overrideValue) {
      throw new Error(`Session is already bound to ${key}=${existingValue}; use a different session name or close the current session first.`)
    }
  }
}

function assertNoDevtoolsConflict(config, otherSessions = []) {
  const currentDevtoolsPort = String((config && config.devtoolsPort) || '').trim()
  if (!currentDevtoolsPort) {
    return
  }

  for (const item of otherSessions) {
    const otherConfig = item && item.config ? item.config : item
    const otherDevtoolsPort = String((otherConfig && otherConfig.devtoolsPort) || '').trim()
    if (!otherDevtoolsPort || otherDevtoolsPort !== currentDevtoolsPort) {
      continue
    }

    throw new Error(`DevTools port ${currentDevtoolsPort} is already bound to another session; choose a different --devtools-port or reuse that session.`)
  }
}

function validateSessionPortConflicts(config, otherSessions = []) {
  assertNoDevtoolsConflict(config, otherSessions)

  const currentAutoPort = String((config && config.autoPort) || '').trim()
  if (!currentAutoPort) {
    return
  }

  for (const item of otherSessions) {
    const otherConfig = item && item.config ? item.config : item
    const otherAutoPort = String((otherConfig && otherConfig.autoPort) || '').trim()
    if (!otherAutoPort || otherAutoPort !== currentAutoPort) {
      continue
    }

    throw new Error(`autoPort ${currentAutoPort} is already bound to another session; choose a different --auto-port or reuse that session.`)
  }
}

function normalizePort(value) {
  if (value === undefined || value === null || value === '') {
    return ''
  }

  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0 || number > 65535) {
    throw new Error(`Invalid port: ${value}`)
  }

  return String(number)
}

async function isPortAvailable(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.close((closeError) => {
        if (closeError) {
          reject(closeError)
          return
        }
        resolve()
      })
    })
  })

  return true
}

async function loadOtherSessionConfigs(sessionDir, sessionName) {
  if (!existsSync(sessionDir)) {
    return []
  }

  const entries = await readdir(sessionDir, { withFileTypes: true })
  const configs = []

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue
    }

    const name = entry.name.slice(0, -'.json'.length)
    if (name === sessionName) {
      continue
    }

    try {
      const raw = await readFile(path.join(sessionDir, entry.name), 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && parsed.config) {
        configs.push({ name, config: parsed.config })
      }
    } catch (_) {
    }
  }

  return configs
}

async function selectPort(preferredPort, range, reservedPorts, availabilityChecker) {
  const normalizedPreferred = normalizePort(preferredPort)
  if (normalizedPreferred) {
    return normalizedPreferred
  }

  for (let port = range.start; port <= range.end; port += 1) {
    if (reservedPorts.has(port)) {
      continue
    }

    try {
      const available = await availabilityChecker(port)
      if (available === false) {
        continue
      }
      return String(port)
    } catch (_) {
    }
  }

  throw new Error(`No free port available in range ${range.start}-${range.end}`)
}

async function assignPorts(config, otherConfigs = [], availabilityChecker = isPortAvailable) {
  validateSessionPortConflicts(config, otherConfigs)

  const reservedDevtoolsPorts = new Set()
  const reservedAutoPorts = new Set()
  for (const item of otherConfigs) {
    const devtoolsPort = Number(item && item.config ? item.config.devtoolsPort : item && item.devtoolsPort)
    if (devtoolsPort) {
      reservedDevtoolsPorts.add(devtoolsPort)
    }
    const autoPort = Number(item && item.config ? item.config.autoPort : item && item.autoPort)
    if (autoPort) {
      reservedAutoPorts.add(autoPort)
    }
  }

  const nextConfig = { ...config }
  nextConfig.devtoolsPort = await selectPort(nextConfig.devtoolsPort, DEVTOOLS_PORT_RANGE, reservedDevtoolsPorts, availabilityChecker)
  reservedAutoPorts.add(Number(nextConfig.devtoolsPort))
  nextConfig.autoPort = await selectPort(nextConfig.autoPort, AUTO_PORT_RANGE, reservedAutoPorts, availabilityChecker)
  return nextConfig
}

async function ensureSessionPorts(state, availabilityChecker = isPortAvailable) {
  const needsDevtoolsPort = !normalizePort(state.config.devtoolsPort)
  const needsAutoPort = !normalizePort(state.config.autoPort)

  state.portResolution = {
    autoPortAssigned: false,
    devtoolsPortAssigned: false,
  }

  if (!needsDevtoolsPort && !needsAutoPort) {
    state.config.devtoolsPort = normalizePort(state.config.devtoolsPort)
    state.config.autoPort = normalizePort(state.config.autoPort)
    return state
  }

  const otherConfigs = await loadOtherSessionConfigs(state.config.sessionDir, state.name)
  state.config = await assignPorts(state.config, otherConfigs, availabilityChecker)
  state.portResolution.devtoolsPortAssigned = needsDevtoolsPort
  state.portResolution.autoPortAssigned = needsAutoPort
  return state
}

function createEmptySessionState({ sessionName, config }) {
  return {
    name: sessionName,
    config,
    route: '',
    epoch: 0,
    nextRefIndex: 1,
    refs: {},
    stableKeyToRef: {},
    lastSnapshot: [],
    consoleEvents: [],
    exceptionEvents: [],
    routeEvents: [],
    lastRouteEventSeq: 0,
    lastVisualProbe: null,
    pendingVisualAction: null,
  }
}

function sessionFilePath(name, config) {
  return path.join(config.sessionDir, `${name}.json`)
}

function sessionLockRoot(config) {
  const repoKey = createHash('sha1')
    .update(String((config && (config.repoRoot || config.sessionDir)) || 'default'))
    .digest('hex')
    .slice(0, 12)
  return path.join(os.tmpdir(), 'miniprogram-browser-locks', repoKey)
}

function sessionLockPath(name, config) {
  return path.join(sessionLockRoot(config), `${name}.lock`)
}

function sessionLockMetaPath(lockPath) {
  return path.join(lockPath, 'meta.json')
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }

  if (pid === process.pid) {
    return true
  }

  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Boolean(error && error.code === 'EPERM')
  }
}

async function readLockMeta(lockPath) {
  try {
    return JSON.parse(await readFile(sessionLockMetaPath(lockPath), 'utf8'))
  } catch (_) {
    return null
  }
}

async function writeLockMeta(lockPath, meta) {
  await writeFile(sessionLockMetaPath(lockPath), JSON.stringify(meta))
}

async function shouldReclaimStaleLock(lockPath, options = {}) {
  const staleHeartbeatMs = Number(options.staleHeartbeatMs || 15000)
  const meta = await readLockMeta(lockPath)
  const now = Date.now()

  if (meta) {
    if (!isProcessAlive(Number(meta.pid))) {
      return true
    }
    const heartbeatAt = Number(meta.heartbeatAt || meta.startedAt || 0)
    if (heartbeatAt > 0 && now - heartbeatAt > staleHeartbeatMs) {
      return true
    }
    return false
  }

  try {
    const info = await stat(lockPath)
    return now - info.mtimeMs > staleHeartbeatMs
  } catch (_) {
    return false
  }
}

async function acquireSessionLock(sessionName, config, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 15000)
  const pollMs = Number(options.pollMs || 100)
  const heartbeatMs = Number(options.heartbeatMs || 2000)
  const lockPath = sessionLockPath(sessionName, config)
  const startedAt = Date.now()

  await mkdir(sessionLockRoot(config), { recursive: true })

  while (Date.now() - startedAt <= timeoutMs) {
    try {
      await mkdir(lockPath)
      const meta = {
        pid: process.pid,
        sessionName,
        command: options.command || '',
        startedAt: Date.now(),
        heartbeatAt: Date.now(),
      }
      await writeLockMeta(lockPath, meta)
      const heartbeatTimer = setInterval(() => {
        void writeLockMeta(lockPath, {
          ...meta,
          heartbeatAt: Date.now(),
        }).catch(() => {})
      }, heartbeatMs)
      heartbeatTimer.unref?.()
      return { path: lockPath, heartbeatTimer }
    } catch (error) {
      if (!error || error.code !== 'EEXIST') {
        throw error
      }

      if (await shouldReclaimStaleLock(lockPath, options)) {
        await rm(lockPath, { recursive: true, force: true })
        continue
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
  }

  throw new Error(`Session lock timeout: ${sessionName}`)
}

async function releaseSessionLock(lock) {
  if (!lock || !lock.path) {
    return
  }

  if (lock.heartbeatTimer) {
    clearInterval(lock.heartbeatTimer)
  }

  await rm(lock.path, { recursive: true, force: true })
}

async function loadSessionState(sessionName, config) {
  const filePath = sessionFilePath(sessionName, config)

  if (!existsSync(filePath)) {
    return createEmptySessionState({ sessionName, config })
  }

  const raw = await readFile(filePath, 'utf8')
  const parsed = JSON.parse(raw)
  const mergedConfig = { ...config, ...(parsed.config || {}) }
  delete mergedConfig.interactiveSelectors
  return {
    ...createEmptySessionState({ sessionName, config }),
    ...parsed,
    name: sessionName,
    config: mergedConfig,
    refs: parsed.refs || {},
    stableKeyToRef: parsed.stableKeyToRef || {},
    lastSnapshot: parsed.lastSnapshot || [],
    consoleEvents: parsed.consoleEvents || [],
    exceptionEvents: parsed.exceptionEvents || [],
    routeEvents: parsed.routeEvents || [],
    lastRouteEventSeq: Number(parsed.lastRouteEventSeq || 0),
    lastVisualProbe: parsed.lastVisualProbe || null,
    pendingVisualAction: parsed.pendingVisualAction || null,
  }
}

async function saveSessionState(state) {
  await mkdir(state.config.sessionDir, { recursive: true })
  const prepared = prepareSessionStateForSave(state)
  await writeFile(sessionFilePath(state.name, state.config), JSON.stringify(prepared, null, 2))
}

function prepareSessionStateForSave(state, options = {}) {
  const maxInactiveRefs = Number(options.maxInactiveRefs || DEFAULT_MAX_INACTIVE_REFS)
  const maxRuntimeEvents = Number(options.maxRuntimeEvents || DEFAULT_MAX_RUNTIME_EVENTS)
  const maxRouteEvents = Number(options.maxRouteEvents || DEFAULT_MAX_ROUTE_EVENTS)
  const refs = { ...(state.refs || {}) }
  const stableKeyToRef = { ...(state.stableKeyToRef || {}) }

  const inactiveEntries = Object.entries(refs)
    .filter(([, record]) => record && record.active === false)
    .sort(([, left], [, right]) => Number((left && left.lastSeenEpoch) || 0) - Number((right && right.lastSeenEpoch) || 0))

  while (inactiveEntries.length > maxInactiveRefs) {
    const [ref, record] = inactiveEntries.shift()
    delete refs[ref]
    if (record && record.stableKey && stableKeyToRef[record.stableKey] === ref) {
      delete stableKeyToRef[record.stableKey]
    }
  }

  const consoleEvents = Array.isArray(state.consoleEvents)
    ? state.consoleEvents.slice(-maxRuntimeEvents)
    : []
  const exceptionEvents = Array.isArray(state.exceptionEvents)
    ? state.exceptionEvents.slice(-maxRuntimeEvents)
    : []
  const routeEvents = Array.isArray(state.routeEvents)
    ? state.routeEvents.slice(-maxRouteEvents)
    : []

  return {
    ...state,
    refs,
    stableKeyToRef,
    consoleEvents,
    exceptionEvents,
    routeEvents,
    lastVisualProbe: state.lastVisualProbe || null,
    pendingVisualAction: state.pendingVisualAction || null,
  }
}

async function listSessionStates(sessionDir) {
  if (!existsSync(sessionDir)) {
    return []
  }

  const entries = await readdir(sessionDir, { withFileTypes: true })
  const states = []

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue
    }

    try {
      const raw = await readFile(path.join(sessionDir, entry.name), 'utf8')
      const parsed = JSON.parse(raw)
      const name = parsed.name || entry.name.slice(0, -'.json'.length)
      states.push({
        name,
        projectPath: parsed.config && parsed.config.projectPath ? parsed.config.projectPath : '',
        devtoolsPort: parsed.config && parsed.config.devtoolsPort ? parsed.config.devtoolsPort : '',
        autoPort: parsed.config && parsed.config.autoPort ? parsed.config.autoPort : '',
        route: parsed.route || '',
        epoch: Number(parsed.epoch || 0),
      })
    } catch (_) {
    }
  }

  return states.sort((left, right) => left.name.localeCompare(right.name))
}

async function clearSessionState(sessionName, config) {
  await rm(sessionFilePath(sessionName, config), { force: true })
}

module.exports = {
  DEVTOOLS_PORT_RANGE,
  AUTO_PORT_RANGE,
  assertBindingConsistency,
  assertNoDevtoolsConflict,
  validateSessionPortConflicts,
  assertProjectPath,
  mergeConfigOverrides,
  detectRepoRoot,
  createDefaultConfig,
  createEmptySessionState,
  assignPorts,
  ensureSessionPorts,
  acquireSessionLock,
  releaseSessionLock,
  prepareSessionStateForSave,
  listSessionStates,
  loadOtherSessionConfigs,
  sessionLockRoot,
  sessionLockPath,
  loadSessionState,
  saveSessionState,
  clearSessionState,
}
