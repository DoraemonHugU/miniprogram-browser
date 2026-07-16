const { existsSync, readFileSync, statSync } = require('node:fs')
const { mkdir, readdir, readFile, rm, stat, writeFile } = require('node:fs/promises')
const { createHash } = require('node:crypto')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

type AnyRecord = Record<string, any>

const DEVTOOLS_PORT_RANGE = { start: 39085, end: 39185 }
const AUTO_PORT_RANGE = { start: 9515, end: 9615 }
const DEFAULT_MAX_INACTIVE_REFS = 200
const DEFAULT_MAX_RUNTIME_EVENTS = 200
const DEFAULT_MAX_ROUTE_EVENTS = 200
const DEFAULT_MAX_RUNTIME_LAUNCH_RECORDS = 100

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
    devtoolsProjectPath: merged.WECHAT_DEVTOOLS_PROJECT || '',
    devtoolsProjectMap: merged.WECHAT_DEVTOOLS_PROJECT_MAP || '',
    trustProject: String(merged.WECHAT_DEVTOOLS_TRUST_PROJECT || '').trim() !== '0',
    devtoolsPort: merged.WECHAT_DEVTOOLS_PORT ? String(merged.WECHAT_DEVTOOLS_PORT) : '',
    autoPort: merged.WECHAT_AUTO_PORT ? String(merged.WECHAT_AUTO_PORT) : '',
    projectPath: '',
    legacySessionDir: '',
    sessionDir: '',
    sessionRegistryFile: path.join(os.homedir(), '.miniprogram-browser', 'session-registry.json'),
    screenshotDir: path.join(repoRoot, 'artifacts/screenshots'),
    tempScreenshotDir: path.join(os.tmpdir(), 'miniprogram-browser'),
  }
}

function normalizeProjectPath(projectPath) {
  if (!projectPath) {
    return ''
  }

  return path.resolve(String(projectPath).trim())
}

function resolveMiniProgramProjectInfo(projectPath) {
  const normalizedProjectPath = normalizeProjectPath(projectPath)
  if (!normalizedProjectPath) {
    throw new Error('Missing project path. Pass --project <miniprogram-root> on first open/session binding.')
  }

  if (!existsSync(normalizedProjectPath) || !statSync(normalizedProjectPath).isDirectory()) {
    throw new Error(`Invalid mini program project path: ${normalizedProjectPath} does not exist or is not a directory.`)
  }

  const projectConfigPath = path.join(normalizedProjectPath, 'project.config.json')
  if (!existsSync(projectConfigPath)) {
    throw new Error(`Invalid mini program project: missing project.config.json under ${normalizedProjectPath}.`)
  }

  let projectConfig
  try {
    projectConfig = JSON.parse(readFileSync(projectConfigPath, 'utf8'))
  } catch (error) {
    throw new Error(`Invalid mini program project: project.config.json is not valid JSON. ${error && error.message ? error.message : error}`)
  }

  const miniprogramRoot = path.resolve(normalizedProjectPath, String(projectConfig.miniprogramRoot || '').trim() || '.')
  if (!existsSync(miniprogramRoot) || !statSync(miniprogramRoot).isDirectory()) {
    throw new Error(`Invalid mini program project: miniprogramRoot does not exist: ${miniprogramRoot}.`)
  }

  const appJsonPath = path.join(miniprogramRoot, 'app.json')
  if (!existsSync(appJsonPath)) {
    throw new Error(`Invalid mini program project: missing app.json under miniprogramRoot ${miniprogramRoot}.`)
  }

  return {
    projectPath: normalizedProjectPath,
    projectConfigPath,
    miniprogramRoot,
    appJsonPath,
  }
}

function tryResolveMiniProgramProjectInfo(projectPath) {
  try {
    return resolveMiniProgramProjectInfo(projectPath)
  } catch (_) {
    return null
  }
}

function findGitWorkTreeRoot(cwd) {
  let currentPath = normalizeProjectPath(cwd)
  while (currentPath) {
    if (existsSync(path.join(currentPath, '.git'))) {
      return currentPath
    }

    const parentPath = path.dirname(currentPath)
    if (!parentPath || parentPath === currentPath) {
      break
    }
    currentPath = parentPath
  }

  return ''
}

function discoverMiniProgramProjectFromCwd(cwd = process.cwd()) {
  let currentPath = normalizeProjectPath(cwd)
  const gitWorkTreeRoot = findGitWorkTreeRoot(currentPath)
  const seen = new Set()
  const childCandidates = ['apps/miniprogram', 'miniprogram']

  while (currentPath) {
    const direct = tryResolveMiniProgramProjectInfo(currentPath)
    if (direct) {
      return direct
    }

    const matches = []
    for (const candidate of childCandidates) {
      const candidatePath = path.join(currentPath, candidate)
      if (seen.has(candidatePath)) {
        continue
      }
      seen.add(candidatePath)
      const info = tryResolveMiniProgramProjectInfo(candidatePath)
      if (info) {
        matches.push(info)
      }
    }
    if (matches.length === 1) {
      return matches[0]
    }

    if (gitWorkTreeRoot && currentPath === gitWorkTreeRoot) {
      break
    }

    const parentPath = path.dirname(currentPath)
    if (!parentPath || parentPath === currentPath) {
      break
    }
    currentPath = parentPath
  }

  return null
}

function resolveGitDir(projectPath) {
  let currentPath = normalizeProjectPath(projectPath)
  if (!currentPath) {
    return ''
  }

  while (true) {
    const dotGitPath = path.join(currentPath, '.git')
    if (existsSync(dotGitPath)) {
      try {
        const info = statSync(dotGitPath)
        if (info.isDirectory()) {
          return dotGitPath
        }
        if (info.isFile()) {
          const raw = readFileSync(dotGitPath, 'utf8')
          const match = raw.match(/^gitdir:\s*(.+)\s*$/imu)
          if (match) {
            return path.resolve(currentPath, match[1])
          }
        }
      } catch (_) {
      }
    }

    const parentPath = path.dirname(currentPath)
    if (!parentPath || parentPath === currentPath) {
      break
    }
    currentPath = parentPath
  }

  return ''
}

function projectStateRoot(config) {
  const projectPath = normalizeProjectPath(config && config.projectPath)
  if (!projectPath) {
    const legacySessionDir = String((config && (config.legacySessionDir || config.sessionDir)) || '').trim()
    if (legacySessionDir) {
      return path.dirname(legacySessionDir)
    }
    const repoKey = createHash('sha1')
      .update(String((config && config.repoRoot) || 'default'))
      .digest('hex')
      .slice(0, 12)
    return path.join(os.tmpdir(), 'miniprogram-browser-state', repoKey)
  }

  const projectKey = createHash('sha1')
    .update(projectPath)
    .digest('hex')
    .slice(0, 12)
  return path.join(os.homedir(), '.miniprogram-browser', 'projects', projectKey)
}

function resolveSessionDir(config) {
  const projectPath = normalizeProjectPath(config && config.projectPath)
  if (!projectPath) {
    return String((config && (config.legacySessionDir || config.sessionDir)) || '').trim()
  }

  return path.join(projectStateRoot(config), 'sessions')
}

function sessionRegistryFilePath(config) {
  return String((config && config.sessionRegistryFile) || path.join(os.homedir(), '.miniprogram-browser', 'session-registry.json'))
}

function sessionIdentityKey(sessionName, projectPath) {
  return `${sessionName}::${normalizeProjectPath(projectPath)}`
}

async function readSessionRegistry(config) {
  const filePath = sessionRegistryFilePath(config)

  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && parsed.sessions ? parsed : { sessions: {} }
  } catch (_) {
    return { sessions: {} }
  }
}

async function writeSessionRegistry(config, registry) {
  const filePath = sessionRegistryFilePath(config)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(registry, null, 2))
}

async function registerSessionProject(sessionName, config) {
  const projectPath = normalizeProjectPath(config && config.projectPath)
  if (!projectPath) {
    return
  }

  const registry = await readSessionRegistry(config)
  const entries = Array.isArray(registry.sessions[sessionName]) ? registry.sessions[sessionName] : []
  registry.sessions[sessionName] = [
    ...entries.filter((item) => normalizeProjectPath(item && item.projectPath) !== projectPath),
    { projectPath, updatedAt: new Date().toISOString() },
  ]
  await writeSessionRegistry(config, registry)
}

async function unregisterSessionProject(sessionName, config) {
  const projectPath = normalizeProjectPath(config && config.projectPath)
  if (!projectPath) {
    return
  }

  const registry = await readSessionRegistry(config)
  const entries = Array.isArray(registry.sessions[sessionName]) ? registry.sessions[sessionName] : []
  const nextEntries = entries.filter((item) => normalizeProjectPath(item && item.projectPath) !== projectPath)
  if (nextEntries.length) {
    registry.sessions[sessionName] = nextEntries
  } else {
    delete registry.sessions[sessionName]
  }
  await writeSessionRegistry(config, registry)
}

function runtimeLaunchRegistryFilePath(config) {
  return path.join(projectStateRoot(config), 'runtime-launches.json')
}

function normalizeRuntimeLaunchId(value) {
  return String(value || '')
    .trim()
    .replace(/[^\w.-]+/gu, '-')
    .slice(0, 120)
}

function normalizeRuntimeLaunchRecord(record) {
  const normalized = {
    ...(record || {}),
    id: normalizeRuntimeLaunchId(record && record.id),
    sessionName: String((record && record.sessionName) || '').trim(),
    projectPath: normalizeProjectPath(record && record.projectPath),
    cliPath: String((record && record.cliPath) || '').trim(),
    devtoolsProjectPath: String((record && record.devtoolsProjectPath) || '').trim(),
    devtoolsProjectMirror: String((record && record.devtoolsProjectMirror) || '').trim(),
    devtoolsProjectAutoLink: String((record && record.devtoolsProjectAutoLink) || '').trim(),
    devtoolsPort: normalizePort(record && record.devtoolsPort),
    autoPort: normalizePort(record && record.autoPort),
    projectStrategy: String((record && record.projectStrategy) || '').trim(),
    status: String((record && record.status) || 'starting').trim(),
    createdAt: String((record && record.createdAt) || '').trim(),
    updatedAt: String((record && record.updatedAt) || '').trim(),
  }
  return normalized
}

async function readRuntimeLaunchRegistry(config) {
  const filePath = runtimeLaunchRegistryFilePath(config)

  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    const launches = Array.isArray(parsed && parsed.launches) ? parsed.launches : []
    return {
      launches: launches
        .map((item) => normalizeRuntimeLaunchRecord(item))
        .filter((item) => item.id && item.projectPath),
    }
  } catch (_) {
    return { launches: [] }
  }
}

async function writeRuntimeLaunchRegistry(config, registry) {
  const filePath = runtimeLaunchRegistryFilePath(config)
  const launches = (Array.isArray(registry && registry.launches) ? registry.launches : [])
    .map((item) => normalizeRuntimeLaunchRecord(item))
    .filter((item) => item.id && item.projectPath)
    .sort((left, right) => String(right.updatedAt || right.createdAt).localeCompare(String(left.updatedAt || left.createdAt)))
    .slice(0, DEFAULT_MAX_RUNTIME_LAUNCH_RECORDS)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify({ launches }, null, 2))
}

async function recordRuntimeLaunch(sessionName, config, metadata: AnyRecord = {}) {
  const projectPath = normalizeProjectPath(config && config.projectPath)
  if (!projectPath) {
    return null
  }

  const now = new Date().toISOString()
  const id = normalizeRuntimeLaunchId(metadata.id || `${sessionName || 'runtime'}-${Date.now()}-${process.pid}`)
  const registry = await readRuntimeLaunchRegistry(config)
  const record = normalizeRuntimeLaunchRecord({
    ...metadata,
    id,
    sessionName,
    projectPath,
    cliPath: config.cliPath || '',
    devtoolsProjectPath: metadata.devtoolsProjectPath || config.devtoolsProjectPath || '',
    devtoolsProjectMirror: metadata.devtoolsProjectMirror || config.devtoolsProjectMirror || '',
    devtoolsProjectAutoLink: metadata.devtoolsProjectAutoLink || config.devtoolsProjectAutoLink || '',
    devtoolsPort: metadata.devtoolsPort || config.devtoolsPort || '',
    autoPort: metadata.autoPort || config.autoPort || '',
    projectStrategy: metadata.projectStrategy || '',
    status: metadata.status || 'starting',
    createdAt: metadata.createdAt || now,
    updatedAt: now,
    pid: process.pid,
  })
  registry.launches = [
    record,
    ...registry.launches.filter((item) => item.id !== id),
  ]
  await writeRuntimeLaunchRegistry(config, registry)
  return record
}

async function updateRuntimeLaunch(id, config, patch: AnyRecord = {}) {
  const launchId = normalizeRuntimeLaunchId(id)
  if (!launchId) {
    return null
  }

  const registry = await readRuntimeLaunchRegistry(config)
  let updatedRecord = null
  registry.launches = registry.launches.map((item) => {
    if (item.id !== launchId) {
      return item
    }
    updatedRecord = normalizeRuntimeLaunchRecord({
      ...item,
      ...patch,
      id: launchId,
      projectPath: item.projectPath,
      updatedAt: new Date().toISOString(),
    })
    return updatedRecord
  })
  await writeRuntimeLaunchRegistry(config, registry)
  return updatedRecord
}

async function removeRuntimeLaunch(id, config) {
  const launchId = normalizeRuntimeLaunchId(id)
  if (!launchId) {
    return false
  }

  const registry = await readRuntimeLaunchRegistry(config)
  const before = registry.launches.length
  registry.launches = registry.launches.filter((item) => item.id !== launchId)
  await writeRuntimeLaunchRegistry(config, registry)
  return registry.launches.length !== before
}

async function listRuntimeLaunches(config) {
  const registry = await readRuntimeLaunchRegistry(config)
  return registry.launches
}

async function resolveSessionConfig(sessionName, config) {
  const explicitProjectPath = normalizeProjectPath(config && config.projectPath)
  if (explicitProjectPath) {
    return {
      ...config,
      projectPath: explicitProjectPath,
      sessionDir: resolveSessionDir({ ...config, projectPath: explicitProjectPath }),
    }
  }

  const registry = await readSessionRegistry(config)
  const entries = Array.isArray(registry.sessions[sessionName]) ? registry.sessions[sessionName] : []
  const candidates = entries
    .map((item) => normalizeProjectPath(item && item.projectPath))
    .filter(Boolean)
    .map((projectPath) => ({
      ...config,
      projectPath,
      sessionDir: resolveSessionDir({ ...config, projectPath }),
    }))
    .filter((candidate) => existsSync(path.join(candidate.sessionDir, `${sessionName}.json`)))

  if (candidates.length === 1) {
    return candidates[0]
  }

  if (candidates.length > 1) {
    throw new Error(`Session name "${sessionName}" exists in multiple projects; pass --project to disambiguate.`)
  }

  return {
    ...config,
    sessionDir: String((config && (config.legacySessionDir || config.sessionDir)) || '').trim(),
  }
}

function assertProjectPath(config) {
  return resolveMiniProgramProjectInfo(config && config.projectPath)
}

function mergeConfigOverrides(baseConfig, overrides: AnyRecord = {}) {
  const merged = { ...(baseConfig || {}) }

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || value === null || value === '') {
      continue
    }
    merged[key] = value
  }

  return merged
}

function assertBindingConsistency(existingConfig, overrides: AnyRecord = {}) {
  const keys = ['projectPath', 'autoPort']

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
  return
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
  await new Promise<void>((resolve, reject) => {
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
  const currentConfig = sessionDir
  const registry = await readSessionRegistry(currentConfig)
  const configs = []
  const seen = new Set()

  for (const [name, entries] of Object.entries(registry.sessions || {})) {
    for (const entry of Array.isArray(entries) ? entries : []) {
      const projectPath = normalizeProjectPath(entry && entry.projectPath)
      if (!projectPath) {
        continue
      }

      const candidateConfig = {
        ...currentConfig,
        projectPath,
        sessionDir: resolveSessionDir({ ...currentConfig, projectPath }),
      }
      const filePath = path.join(candidateConfig.sessionDir, `${name}.json`)
      if (!existsSync(filePath)) {
        continue
      }

      if (name === sessionName && projectPath === normalizeProjectPath(currentConfig.projectPath)) {
        continue
      }

      const identity = sessionIdentityKey(name, projectPath)
      if (seen.has(identity)) {
        continue
      }
      seen.add(identity)

      try {
        const raw = await readFile(filePath, 'utf8')
        const parsed = JSON.parse(raw)
        if (parsed && parsed.config) {
          configs.push({
            name,
            route: parsed.route || '',
            epoch: Number(parsed.epoch || 0),
            config: { ...candidateConfig, ...(parsed.config || {}) },
          })
        }
      } catch (_) {
      }
    }
  }

  const legacySessionDir = String((currentConfig && (currentConfig.legacySessionDir || currentConfig.sessionDir)) || '').trim()
  if (legacySessionDir && existsSync(legacySessionDir)) {
    const entries = await readdir(legacySessionDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        continue
      }
      const name = entry.name.slice(0, -'.json'.length)
      if (name === sessionName && !normalizeProjectPath(currentConfig.projectPath)) {
        continue
      }
      const identity = sessionIdentityKey(name, '')
      if (seen.has(identity)) {
        continue
      }
      try {
        const raw = await readFile(path.join(legacySessionDir, entry.name), 'utf8')
        const parsed = JSON.parse(raw)
        if (parsed && parsed.config) {
          const parsedProjectPath = normalizeProjectPath(parsed.config.projectPath)
          const currentProjectPath = normalizeProjectPath(currentConfig.projectPath)
          if (name === sessionName && (!parsedProjectPath || parsedProjectPath === currentProjectPath)) {
            continue
          }
          configs.push({
            name,
            route: parsed.route || '',
            epoch: Number(parsed.epoch || 0),
            config: { ...currentConfig, ...(parsed.config || {}), sessionDir: legacySessionDir },
          })
          seen.add(identity)
        }
      } catch (_) {
      }
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

  const reservedAutoPorts = new Set()
  for (const item of otherConfigs) {
    const otherConfig = item && item.config ? item.config : item
    const autoPort = Number(otherConfig && otherConfig.autoPort)
    if (autoPort) {
      reservedAutoPorts.add(autoPort)
    }
    const devtoolsPort = Number(otherConfig && otherConfig.devtoolsPort)
    if (devtoolsPort) {
      reservedAutoPorts.add(devtoolsPort)
    }
  }

  const nextConfig = { ...config }
  nextConfig.devtoolsPort = normalizePort(nextConfig.devtoolsPort)
  if (nextConfig.devtoolsPort) {
    reservedAutoPorts.add(Number(nextConfig.devtoolsPort))
  }
  nextConfig.autoPort = await selectPort(nextConfig.autoPort, AUTO_PORT_RANGE, reservedAutoPorts, availabilityChecker)
  return nextConfig
}

async function ensureSessionPorts(state, availabilityChecker = isPortAvailable) {
  const needsAutoPort = !normalizePort(state.config.autoPort)

  state.portResolution = {
    autoPortAssigned: false,
    devtoolsPortAssigned: false,
  }

  if (!state.config.legacySessionDir && state.config.sessionDir) {
    state.config.legacySessionDir = state.config.sessionDir
  }
  state.config.projectPath = normalizeProjectPath(state.config.projectPath)
  state.config.sessionDir = resolveSessionDir(state.config)

  if (!needsAutoPort) {
    state.config.devtoolsPort = normalizePort(state.config.devtoolsPort)
    state.config.autoPort = normalizePort(state.config.autoPort)
    return state
  }

  const otherConfigs = await loadOtherSessionConfigs(state.config, state.name)
  state.config = await assignPorts(state.config, otherConfigs, availabilityChecker)
  state.portResolution.devtoolsPortAssigned = false
  state.portResolution.autoPortAssigned = needsAutoPort
  return state
}

function createEmptySessionState({ sessionName, config }) {
  return {
    name: sessionName,
    bound: false,
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
  return path.join(resolveSessionDir(config), `${name}.json`)
}

function sessionLockRoot(config) {
  if (normalizeProjectPath(config && config.projectPath)) {
    return path.join(projectStateRoot(config), 'locks')
  }
  const repoKey = createHash('sha1')
    .update(String((config && (config.repoRoot || config.sessionDir)) || 'default'))
    .digest('hex')
    .slice(0, 12)
  return path.join(os.tmpdir(), 'miniprogram-browser-locks', repoKey)
}

function sessionLockPath(name, config) {
  return path.join(sessionLockRoot(config), `${name}.lock`)
}

function runtimeLockName(config) {
  const autoPort = normalizePort(config && config.autoPort)
  if (!autoPort) {
    return ''
  }
  return `__runtime_auto_${autoPort}`
}

function selectAttachableRuntimeSession(sessions = []) {
  const liveSessions = (sessions || []).filter((item) => item && item.status === 'live' && item.autoPort)
  if (liveSessions.length === 1) {
    return {
      mode: 'attach',
      session: liveSessions[0],
    }
  }
  if (liveSessions.length > 1) {
    return {
      mode: 'ambiguous',
      sessions: liveSessions,
    }
  }
  return {
    mode: 'none',
    sessions: [],
  }
}

function shouldShutdownRuntimeOnClose(state, options: AnyRecord = {}) {
  if (options.runtime) {
    return true
  }
  return !Boolean(state && state.runtimeAttached)
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

async function shouldReclaimStaleLock(lockPath, options: AnyRecord = {}) {
  const staleHeartbeatMs = Number(options.staleHeartbeatMs || process.env.MINIPROGRAM_BROWSER_LOCK_STALE_MS || 15000)
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

async function acquireSessionLock(sessionName, config, options: AnyRecord = {}) {
  const timeoutMs = Number(options.timeoutMs || process.env.MINIPROGRAM_BROWSER_LOCK_TIMEOUT_MS || 120000)
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

  const meta = await readLockMeta(lockPath)
  if (meta) {
    const parts = []
    if (meta.pid) {
      parts.push(`pid=${meta.pid}`)
    }
    if (meta.command) {
      parts.push(`command=${meta.command}`)
    }
    if (parts.length) {
      throw new Error(`Session is busy: ${sessionName} (${parts.join(' ')}). 同一 session 只允许串行执行；请等待当前命令完成，或改用不同的 --session。`)
    }
  }

  throw new Error(`Session is busy: ${sessionName}. 同一 session 只允许串行执行；请等待当前命令完成，或改用不同的 --session。`)
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
  const resolvedConfig = await resolveSessionConfig(sessionName, config)
  const filePath = sessionFilePath(sessionName, resolvedConfig)

  if (!existsSync(filePath)) {
    return createEmptySessionState({ sessionName, config: resolvedConfig })
  }

  const raw = await readFile(filePath, 'utf8')
  const parsed = JSON.parse(raw)
  const mergedConfig = { ...resolvedConfig, ...(parsed.config || {}) }
  mergedConfig.projectPath = normalizeProjectPath(mergedConfig.projectPath)
  mergedConfig.sessionDir = resolveSessionDir(mergedConfig)
  delete mergedConfig.interactiveSelectors
  return {
    ...createEmptySessionState({ sessionName, config: resolvedConfig }),
    ...parsed,
    name: sessionName,
    bound: true,
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
  state.config.projectPath = normalizeProjectPath(state.config.projectPath)
  state.config.sessionDir = resolveSessionDir(state.config)
  await mkdir(state.config.sessionDir, { recursive: true })
  const prepared = prepareSessionStateForSave(state)
  await writeFile(sessionFilePath(state.name, state.config), JSON.stringify(prepared, null, 2))
  await registerSessionProject(state.name, state.config)
}

function prepareSessionStateForSave(state, options: AnyRecord = {}) {
  const maxInactiveRefs = Number(options.maxInactiveRefs || DEFAULT_MAX_INACTIVE_REFS)
  const maxRuntimeEvents = Number(options.maxRuntimeEvents || DEFAULT_MAX_RUNTIME_EVENTS)
  const maxRouteEvents = Number(options.maxRouteEvents || DEFAULT_MAX_ROUTE_EVENTS)
  const refs: AnyRecord = { ...(state.refs || {}) }
  const stableKeyToRef: AnyRecord = { ...(state.stableKeyToRef || {}) }

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
  if (typeof sessionDir === 'object' && sessionDir) {
    const otherConfigs = await loadOtherSessionConfigs(sessionDir, '')
    return otherConfigs
      .map((item) => ({
        name: item.name,
        projectPath: item.config && item.config.projectPath ? item.config.projectPath : '',
        devtoolsProjectPath: item.config && item.config.devtoolsProjectPath ? item.config.devtoolsProjectPath : '',
        devtoolsPort: item.config && item.config.devtoolsPort ? item.config.devtoolsPort : '',
        autoPort: item.config && item.config.autoPort ? item.config.autoPort : '',
        runtimeAttached: Boolean(item.runtimeAttached),
        runtimeOwnerSession: item.runtimeOwnerSession || '',
        route: item.route || '',
        epoch: Number(item.epoch || 0),
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
  }

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
        devtoolsProjectPath: parsed.config && parsed.config.devtoolsProjectPath ? parsed.config.devtoolsProjectPath : '',
        devtoolsPort: parsed.config && parsed.config.devtoolsPort ? parsed.config.devtoolsPort : '',
        autoPort: parsed.config && parsed.config.autoPort ? parsed.config.autoPort : '',
        runtimeAttached: Boolean(parsed.runtimeAttached),
        runtimeOwnerSession: parsed.runtimeOwnerSession || '',
        route: parsed.route || '',
        epoch: Number(parsed.epoch || 0),
      })
    } catch (_) {
    }
  }

  return states.sort((left, right) => left.name.localeCompare(right.name))
}

async function clearSessionState(sessionName, config) {
  const resolvedConfig = await resolveSessionConfig(sessionName, config)
  await rm(sessionFilePath(sessionName, resolvedConfig), { force: true })
  await unregisterSessionProject(sessionName, resolvedConfig)
}

module.exports = {
  DEVTOOLS_PORT_RANGE,
  AUTO_PORT_RANGE,
  assertBindingConsistency,
  assertNoDevtoolsConflict,
  validateSessionPortConflicts,
  assertProjectPath,
  resolveMiniProgramProjectInfo,
  discoverMiniProgramProjectFromCwd,
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
  listRuntimeLaunches,
  runtimeLockName,
  recordRuntimeLaunch,
  updateRuntimeLaunch,
  removeRuntimeLaunch,
  selectAttachableRuntimeSession,
  shouldShutdownRuntimeOnClose,
  sessionLockRoot,
  sessionLockPath,
  resolveSessionConfig,
  loadSessionState,
  saveSessionState,
  clearSessionState,
}
