const { existsSync, readFileSync, statSync } = require('node:fs')
const { mkdir, readdir, readFile, rm, stat, writeFile } = require('node:fs/promises')
const { createHash } = require('node:crypto')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { resolveEnvironment } = require('./platform')

type AnyRecord = Record<string, unknown>

/** 宽松的配置参数类型（函数内部使用，保留属性访问） */
interface LaxConfig {
  repoRoot?: string
  cliPath?: string
  devtoolsProjectPath?: string
  devtoolsProjectMap?: string
  trustProject?: boolean | string
  devtoolsPort?: string
  autoPort?: string
  projectPath?: string
  legacySessionDir?: string
  sessionDir?: string
  sessionRegistryFile?: string
  screenshotDir?: string
  tempScreenshotDir?: string
  devtoolsProjectMirror?: string
  devtoolsProjectAutoLink?: string
  [key: string]: unknown
}

interface LockHandle {
  path: string
  heartbeatTimer?: ReturnType<typeof setInterval>
}

interface RuntimeLaunchRecord {
  id: string
  sessionName: string
  projectPath: string
  cliPath: string
  devtoolsProjectPath: string
  devtoolsProjectMirror: string
  devtoolsProjectAutoLink: string
  devtoolsPort: string
  autoPort: string
  projectStrategy: string
  status: string
  createdAt: string
  updatedAt: string
  pid?: number
  [key: string]: unknown
}

interface SessionConfig {
  repoRoot: string
  cliPath: string
  devtoolsProjectPath: string
  devtoolsProjectMap: string
  trustProject: boolean
  devtoolsPort: string
  autoPort: string
  projectPath: string
  legacySessionDir: string
  sessionDir: string
  sessionRegistryFile: string
  screenshotDir: string
  tempScreenshotDir: string
  [key: string]: unknown
}

const DEVTOOLS_PORT_RANGE = { start: 39085, end: 39185 }
const AUTO_PORT_RANGE = { start: 9515, end: 9615 }
const WSL_PREFERRED_AUTO_PORT = 9530
const DEFAULT_MAX_INACTIVE_REFS = 200
const DEFAULT_MAX_RUNTIME_EVENTS = 200
const DEFAULT_MAX_ROUTE_EVENTS = 200
const DEFAULT_MAX_RUNTIME_LAUNCH_RECORDS = 100
/** starting 超过此时长仍未变 live → 视为僵尸，标 stale（冷启动失败常见残留） */
const DEFAULT_STARTING_LAUNCH_MAX_AGE_MS = 3 * 60 * 1000

function detectRepoRoot(): string {
  return path.resolve(__dirname, '../..')
}

function createDefaultConfig(repoRoot: string = detectRepoRoot()): SessionConfig {
  const merged: Record<string, string | undefined> = { ...process.env }

  let defaultCliPath = ''
  if (process.platform === 'darwin') {
    defaultCliPath = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli'
  } else if (process.platform === 'win32') {
    defaultCliPath = 'C:\\Program Files (x86)\\Tencent\\微信web开发者工具\\cli.js'
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

function normalizeProjectPath(projectPath: unknown): string {
  if (!projectPath) {
    return ''
  }

  return path.resolve(String(projectPath).trim())
}

interface MiniProgramProjectInfo {
  projectPath: string
  projectConfigPath: string
  miniprogramRoot: string
  appJsonPath: string
}

function resolveMiniProgramProjectInfo(projectPath: unknown): MiniProgramProjectInfo {
  const normalizedProjectPath = normalizeProjectPath(projectPath)
  if (!normalizedProjectPath) {
    throw new Error('Missing project path. 请在小程序项目目录执行，或传 --project <miniprogram-root> 后再 open/session 绑定。')
  }

  if (!existsSync(normalizedProjectPath) || !statSync(normalizedProjectPath).isDirectory()) {
    throw new Error(`Invalid mini program project path: ${normalizedProjectPath} does not exist or is not a directory.`)
  }

  const projectConfigPath = path.join(normalizedProjectPath, 'project.config.json')
  if (!existsSync(projectConfigPath)) {
    throw new Error(`Invalid mini program project: missing project.config.json under ${normalizedProjectPath}.`)
  }

  let projectConfig: AnyRecord
  try {
    projectConfig = JSON.parse(readFileSync(projectConfigPath, 'utf8'))
  } catch (error: unknown) {
    throw new Error(`Invalid mini program project: project.config.json is not valid JSON. ${error && typeof error === 'object' && 'message' in error ? String((error as Error).message) : String(error)}`)
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

function tryResolveMiniProgramProjectInfo(projectPath: unknown): MiniProgramProjectInfo | null {
  try {
    return resolveMiniProgramProjectInfo(projectPath)
  } catch (_: unknown) {
    return null
  }
}

function findGitWorkTreeRoot(cwd: unknown): string {
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

function discoverMiniProgramProjectFromCwd(cwd: string = process.cwd()): MiniProgramProjectInfo | null {
  let currentPath = normalizeProjectPath(cwd)
  const gitWorkTreeRoot = findGitWorkTreeRoot(currentPath)
  const seen = new Set<string>()
  const childCandidates = ['apps/miniprogram', 'miniprogram']

  while (currentPath) {
    const direct = tryResolveMiniProgramProjectInfo(currentPath)
    if (direct) {
      return direct
    }

    const matches: MiniProgramProjectInfo[] = []
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

function resolveGitDir(projectPath: unknown): string {
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
            return path.resolve(currentPath, match[1].trim())
          }
        }
      } catch (_: unknown) {
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

function projectStateRoot(config: AnyRecord = {}): string {
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

function resolveSessionDir(config: AnyRecord = {}): string {
  const projectPath = normalizeProjectPath(config && config.projectPath)
  if (!projectPath) {
    return String((config && (config.legacySessionDir || config.sessionDir)) || '').trim()
  }

  return path.join(projectStateRoot(config), 'sessions')
}

function sessionRegistryFilePath(config: AnyRecord = {}): string {
  return String((config && config.sessionRegistryFile) || path.join(os.homedir(), '.miniprogram-browser', 'session-registry.json'))
}

function sessionIdentityKey(sessionName: string, projectPath: string): string {
  return `${sessionName}::${normalizeProjectPath(projectPath)}`
}

/**
 * 从项目路径推导可读 session slug（不含 -xN）。
 * leaf 为 miniprogram/weapp/apps 等泛名时向上取有意义的一段。
 */
function projectSessionSlug(projectPath: string): string {
  const normalized = String(projectPath || '').trim().replace(/\\/gu, '/')
  if (!normalized) {
    return 'project'
  }

  const parts = normalized.split('/').filter(Boolean)
  if (!parts.length) {
    return 'project'
  }

  const genericLeaves = new Set(['miniprogram', 'weapp', 'miniapp', 'mp', 'src', 'app', 'apps', 'client', 'frontend'])
  let leaf = parts[parts.length - 1]
  if (genericLeaves.has(leaf.toLowerCase())) {
    for (let index = parts.length - 2; index >= 0; index -= 1) {
      const candidate = parts[index]
      if (!genericLeaves.has(candidate.toLowerCase())) {
        leaf = candidate
        break
      }
    }
  }

  let slug = leaf
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  if (!slug) {
    slug = 'project'
  }
  if (slug.length > 32) {
    slug = slug.slice(0, 32).replace(/-+$/gu, '') || 'project'
  }
  return slug
}

function isAutoProjectSessionName(sessionName: string, projectSlugOrPath: string): boolean {
  const name = String(sessionName || '').trim()
  const slug = String(projectSlugOrPath || '').includes('/') || String(projectSlugOrPath || '').includes('\\')
    ? projectSessionSlug(projectSlugOrPath)
    : String(projectSlugOrPath || '').trim().toLowerCase()
  if (!name || !slug) {
    return false
  }
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`^${escaped}-x([1-9]\\d*)$`, 'u').test(name)
}

function listAutoProjectSessionIndexes(existingNames: string[] = [], projectPath: string): number[] {
  const slug = projectSessionSlug(projectPath)
  const indexes: number[] = []
  for (const name of existingNames || []) {
    if (!isAutoProjectSessionName(name, slug)) {
      continue
    }
    const match = String(name).match(/-x([1-9]\d*)$/u)
    if (match) {
      indexes.push(Number(match[1]))
    }
  }
  return indexes.sort((left, right) => left - right)
}

/** 复用：已有自动 session 取最大序号；否则 project-x1 */
function pickAutoProjectSessionName(existingNames: string[] = [], projectPath: string): string {
  const slug = projectSessionSlug(projectPath)
  const indexes = listAutoProjectSessionIndexes(existingNames, projectPath)
  if (!indexes.length) {
    return `${slug}-x1`
  }
  return `${slug}-x${indexes[indexes.length - 1]}`
}

/** 新开：下一个空闲 project-xN */
function nextAutoProjectSessionName(existingNames: string[] = [], projectPath: string): string {
  const slug = projectSessionSlug(projectPath)
  const indexes = listAutoProjectSessionIndexes(existingNames, projectPath)
  const next = indexes.length ? indexes[indexes.length - 1] + 1 : 1
  return `${slug}-x${next}`
}

async function readSessionRegistry(config: AnyRecord = {}): Promise<{ sessions: Record<string, unknown[]> }> {
  const filePath = sessionRegistryFilePath(config)

  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && (parsed as AnyRecord).sessions ? parsed as { sessions: Record<string, unknown[]> } : { sessions: {} }
  } catch (_: unknown) {
    return { sessions: {} }
  }
}

async function writeSessionRegistry(config: AnyRecord = {}, registry: { sessions: Record<string, unknown[]> }): Promise<void> {
  const filePath = sessionRegistryFilePath(config)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(registry, null, 2))
}

async function registerSessionProject(sessionName: string, config: AnyRecord = {}): Promise<void> {
  const projectPath = normalizeProjectPath(config && config.projectPath)
  if (!projectPath) {
    return
  }

  const registry = await readSessionRegistry(config)
  const entries = Array.isArray(registry.sessions[sessionName]) ? registry.sessions[sessionName] as AnyRecord[] : []
  registry.sessions[sessionName] = [
    ...entries.filter((item: AnyRecord) => normalizeProjectPath(item && item.projectPath) !== projectPath),
    { projectPath, updatedAt: new Date().toISOString() },
  ]
  await writeSessionRegistry(config, registry)
}

async function unregisterSessionProject(sessionName: string, config: AnyRecord = {}): Promise<void> {
  const projectPath = normalizeProjectPath(config && config.projectPath)
  if (!projectPath) {
    return
  }

  const registry = await readSessionRegistry(config)
  const entries = Array.isArray(registry.sessions[sessionName]) ? registry.sessions[sessionName] as AnyRecord[] : []
  const nextEntries = entries.filter((item: AnyRecord) => normalizeProjectPath(item && item.projectPath) !== projectPath)
  if (nextEntries.length) {
    registry.sessions[sessionName] = nextEntries
  } else {
    delete registry.sessions[sessionName]
  }
  await writeSessionRegistry(config, registry)
}

function runtimeLaunchRegistryFilePath(config: AnyRecord = {}): string {
  return path.join(projectStateRoot(config), 'runtime-launches.json')
}

function activeSessionFilePath(config: AnyRecord = {}): string {
  return path.join(projectStateRoot(config), 'active-session.json')
}

interface ActiveSessionState {
  sessionName: string
  updatedAt: string
}

async function getActiveSession(config: AnyRecord = {}): Promise<ActiveSessionState | null> {
  if (!normalizeProjectPath(config && config.projectPath)) {
    return null
  }

  try {
    const parsed = JSON.parse(await readFile(activeSessionFilePath(config), 'utf8')) as AnyRecord
    const sessionName = String((parsed && (parsed.sessionName || parsed.name)) || '').trim()
    if (!sessionName) {
      return null
    }
    return {
      sessionName,
      updatedAt: String((parsed && parsed.updatedAt) || '').trim(),
    }
  } catch (_: unknown) {
    return null
  }
}

async function setActiveSession(sessionName: string, config: AnyRecord = {}): Promise<void> {
  const normalizedProjectPath = normalizeProjectPath(config && config.projectPath)
  const normalizedSessionName = String(sessionName || '').trim()
  if (!normalizedProjectPath || !normalizedSessionName) {
    return
  }

  const filePath = activeSessionFilePath({ ...config, projectPath: normalizedProjectPath })
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify({
    sessionName: normalizedSessionName,
    updatedAt: new Date().toISOString(),
  }, null, 2))
}

async function clearActiveSession(sessionName: string, config: AnyRecord = {}): Promise<boolean> {
  const active = await getActiveSession(config)
  if (!active || active.sessionName !== String(sessionName || '').trim()) {
    return false
  }

  await rm(activeSessionFilePath(config), { force: true })
  return true
}

function normalizeRuntimeLaunchId(value: unknown): string {
  return String(value || '')
    .trim()
    .replace(/[^\w.-]+/gu, '-')
    .slice(0, 120)
}

function normalizeRuntimeLaunchRecord(record: AnyRecord = {}): RuntimeLaunchRecord {
  const normalized: RuntimeLaunchRecord = {
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

async function readRuntimeLaunchRegistry(config: AnyRecord = {}): Promise<{ launches: RuntimeLaunchRecord[] }> {
  const filePath = runtimeLaunchRegistryFilePath(config)

  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    const launches = Array.isArray(parsed && (parsed as AnyRecord).launches) ? (parsed as AnyRecord).launches as AnyRecord[] : []
    return {
      launches: launches
        .map((item: AnyRecord) => normalizeRuntimeLaunchRecord(item))
        .filter((item: RuntimeLaunchRecord) => item.id && item.projectPath),
    }
  } catch (_: unknown) {
    return { launches: [] }
  }
}

async function writeRuntimeLaunchRegistry(config: AnyRecord = {}, registry: { launches: RuntimeLaunchRecord[] }): Promise<void> {
  const filePath = runtimeLaunchRegistryFilePath(config)
  const launches = (Array.isArray(registry && registry.launches) ? registry.launches : [])
    .map((item: RuntimeLaunchRecord) => normalizeRuntimeLaunchRecord(item))
    .filter((item: RuntimeLaunchRecord) => item.id && item.projectPath)
    .sort((left: RuntimeLaunchRecord, right: RuntimeLaunchRecord) => String(right.updatedAt || right.createdAt).localeCompare(String(left.updatedAt || left.createdAt)))
    .slice(0, DEFAULT_MAX_RUNTIME_LAUNCH_RECORDS)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify({ launches }, null, 2))
}

async function recordRuntimeLaunch(sessionName: string, config: AnyRecord = {}, metadata: AnyRecord = {}): Promise<RuntimeLaunchRecord | null> {
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
    devtoolsProjectPath: (metadata.devtoolsProjectPath as string) || (config.devtoolsProjectPath as string) || '',
    devtoolsProjectMirror: (metadata.devtoolsProjectMirror as string) || (config.devtoolsProjectMirror as string) || '',
    devtoolsProjectAutoLink: (metadata.devtoolsProjectAutoLink as string) || (config.devtoolsProjectAutoLink as string) || '',
    devtoolsPort: (metadata.devtoolsPort as string) || (config.devtoolsPort as string) || '',
    autoPort: (metadata.autoPort as string) || (config.autoPort as string) || '',
    projectStrategy: (metadata.projectStrategy as string) || '',
    status: (metadata.status as string) || 'starting',
    createdAt: (metadata.createdAt as string) || now,
    updatedAt: now,
    pid: process.pid,
  })
  registry.launches = [
    record,
    ...registry.launches.filter((item: RuntimeLaunchRecord) => item.id !== id),
  ]
  await writeRuntimeLaunchRegistry(config, registry)
  return record
}

async function updateRuntimeLaunch(id: unknown, config: AnyRecord = {}, patch: AnyRecord = {}): Promise<RuntimeLaunchRecord | null> {
  const launchId = normalizeRuntimeLaunchId(id)
  if (!launchId) {
    return null
  }

  const registry = await readRuntimeLaunchRegistry(config)
  let updatedRecord: RuntimeLaunchRecord | null = null
  registry.launches = registry.launches.map((item: RuntimeLaunchRecord) => {
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

async function removeRuntimeLaunch(id: unknown, config: AnyRecord = {}): Promise<boolean> {
  const launchId = normalizeRuntimeLaunchId(id)
  if (!launchId) {
    return false
  }

  const registry = await readRuntimeLaunchRegistry(config)
  const before = registry.launches.length
  registry.launches = registry.launches.filter((item: RuntimeLaunchRecord) => item.id !== launchId)
  await writeRuntimeLaunchRegistry(config, registry)
  return registry.launches.length !== before
}

async function listRuntimeLaunches(config: AnyRecord = {}): Promise<RuntimeLaunchRecord[]> {
  const registry = await readRuntimeLaunchRegistry(config)
  return registry.launches
}

/**
 * 清理 runtime 池噪音：过期 starting → stale。
 * 不删记录（保留观测）；open attach / session list 前调用即可。
 */
async function reconcileRuntimeLaunches(
  config: AnyRecord = {},
  options: { startingMaxAgeMs?: number; nowMs?: number } = {},
): Promise<{ markedStale: number }> {
  const maxAgeMs = Math.max(10_000, Number(options.startingMaxAgeMs || DEFAULT_STARTING_LAUNCH_MAX_AGE_MS))
  const nowMs = Number(options.nowMs || Date.now())
  const registry = await readRuntimeLaunchRegistry(config)
  let markedStale = 0
  let changed = false

  registry.launches = registry.launches.map((item: RuntimeLaunchRecord) => {
    if (!item || String(item.status || '') !== 'starting') {
      return item
    }
    const stamp = String(item.updatedAt || item.createdAt || '').trim()
    const ageMs = stamp ? Math.max(0, nowMs - Date.parse(stamp)) : maxAgeMs + 1
    if (!Number.isFinite(ageMs) || ageMs < maxAgeMs) {
      return item
    }
    markedStale += 1
    changed = true
    return normalizeRuntimeLaunchRecord({
      ...item,
      status: 'stale',
      updatedAt: new Date(nowMs).toISOString(),
    })
  })

  if (changed) {
    await writeRuntimeLaunchRegistry(config, registry)
  }
  return { markedStale }
}

/**
 * 临时/门禁 session 名：e2e / gate / 一次性测试前缀。
 * 用于 list 默认隐藏「无 route 的 stale」噪音行。
 */
function isEphemeralNoiseSessionName(sessionName: string): boolean {
  const name = String(sessionName || '').trim()
  if (!name) {
    return false
  }
  return /^(gate|e2e|test)[-_]/iu.test(name)
    || /^e2e-(a|b|fresh)-/iu.test(name)
}

async function resolveSessionConfig(sessionName: string, config: AnyRecord = {}): Promise<AnyRecord> {
  const explicitProjectPath = normalizeProjectPath(config && config.projectPath)
  if (explicitProjectPath) {
    return {
      ...config,
      projectPath: explicitProjectPath,
      sessionDir: resolveSessionDir({ ...config, projectPath: explicitProjectPath }),
    }
  }

  const registry = await readSessionRegistry(config)
  const entries = Array.isArray(registry.sessions[sessionName]) ? registry.sessions[sessionName] as AnyRecord[] : []
  const candidates = entries
    .map((item: AnyRecord) => normalizeProjectPath(item && item.projectPath))
    .filter(Boolean)
    .map((projectPath: string) => ({
      ...config,
      projectPath,
      sessionDir: resolveSessionDir({ ...config, projectPath }),
    }))
    .filter((candidate: AnyRecord) => existsSync(path.join(candidate.sessionDir as string, `${sessionName}.json`)))

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

function assertProjectPath(config: AnyRecord = {}): MiniProgramProjectInfo {
  return resolveMiniProgramProjectInfo(config && config.projectPath)
}

function mergeConfigOverrides(baseConfig: AnyRecord = {}, overrides: AnyRecord = {}): AnyRecord {
  const merged: AnyRecord = { ...(baseConfig || {}) }

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || value === null || value === '') {
      continue
    }
    merged[key] = value
  }

  return merged
}

function assertBindingConsistency(existingConfig: AnyRecord = {}, overrides: AnyRecord = {}): void {
  const keys = ['projectPath']

  for (const key of keys) {
    const existingValue = normalizeProjectPath(existingConfig && existingConfig[key])
    const overrideValue = normalizeProjectPath(overrides && overrides[key])

    if (!existingValue || !overrideValue) {
      continue
    }

    if (existingValue !== overrideValue) {
      throw new Error(`Session is already bound to ${key}=${existingValue}; use a different session name or close the current session first.`)
    }
  }
}

function assertNoDevtoolsConflict(config: AnyRecord = {}, _otherSessions: AnyRecord[] = []): void {
  return
}

interface OtherSessionInfo {
  name: string
  route: string
  epoch: number
  config: AnyRecord
  [key: string]: unknown
}

function validateSessionPortConflicts(config: AnyRecord = {}, otherSessions: AnyRecord[] = []): void {
  assertNoDevtoolsConflict(config, otherSessions)

  const currentAutoPort = String((config && config.autoPort) || '').trim()
  if (!currentAutoPort) {
    return
  }

  const currentProject = normalizeProjectPath(config && config.projectPath)
  for (const item of otherSessions) {
    const otherConfig = (item && item.config ? item.config : item) as AnyRecord
    const otherAutoPort = String((otherConfig && otherConfig.autoPort) || '').trim()
    if (!otherAutoPort || otherAutoPort !== currentAutoPort) {
      continue
    }
    // 同项目共享同一 automation 端口是 attach 语义，不是冲突
    const otherProject = normalizeProjectPath(otherConfig && otherConfig.projectPath)
    if (currentProject && otherProject && currentProject === otherProject) {
      continue
    }

    throw new Error(`autoPort ${currentAutoPort} is already bound to another session; choose a different --auto-port or reuse that session.`)
  }
}

function normalizePort(value: unknown): string {
  if (value === undefined || value === null || value === '') {
    return ''
  }

  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0 || number > 65535) {
    throw new Error(`Invalid port: ${value}`)
  }

  return String(number)
}

async function isPortAvailable(port: number): Promise<boolean> {
  await new Promise<void>((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.close((closeError: unknown) => {
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

/** 只连接探测，不占用端口；用于 WSL 判断 Windows 侧是否已有 listener。 */
async function isPortNotListening(port: number, timeoutMs = 150): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    let settled = false
    const finish = (available: boolean) => {
      if (settled) {
        return
      }
      settled = true
      socket.destroy()
      resolve(available)
    }
    socket.setTimeout(Math.max(1, timeoutMs))
    socket.once('connect', () => finish(false))
    socket.once('timeout', () => finish(true))
    socket.once('error', () => finish(true))
  })
}

/** WSL mirrored networking 下预绑定端口会短暂阻塞随后执行的 Windows bind。 */
async function isAutomationPortAvailable(port: number, config: AnyRecord = {}, options: AnyRecord = {}): Promise<boolean> {
  const localChecker = (options.localChecker as ((value: number) => Promise<boolean>) | undefined) || isPortAvailable
  if (resolveEnvironment(config, options).isWsl) {
    const wslChecker = (options.wslChecker as ((value: number) => Promise<boolean>) | undefined) || isPortNotListening
    // 不从 WSL 侧 bind；但要排除已有 listener，避免误附着到其它项目的 runtime。
    return await wslChecker(port)
  }
  return await localChecker(port)
}

async function loadOtherSessionConfigs(sessionDirOrConfig: AnyRecord, sessionName: string): Promise<OtherSessionInfo[]> {
  const currentConfig = sessionDirOrConfig
  const registry = await readSessionRegistry(currentConfig)
  const configs: OtherSessionInfo[] = []
  const seen = new Set<string>()

  for (const [name, entries] of Object.entries(registry.sessions || {})) {
    for (const entry of Array.isArray(entries) ? entries as AnyRecord[] : []) {
      const projectPath = normalizeProjectPath(entry && entry.projectPath)
      if (!projectPath) {
        continue
      }

      const candidateConfig: AnyRecord = {
        ...stripRuntimeFields(currentConfig),
        projectPath,
        sessionDir: resolveSessionDir({ ...stripRuntimeFields(currentConfig), projectPath }),
      }
      const filePath = path.join(candidateConfig.sessionDir as string, `${name}.json`)
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
        const parsed = JSON.parse(raw) as AnyRecord
        if (parsed && parsed.config) {
          configs.push({
            name,
            route: (parsed.route as string) || '',
            epoch: Number(parsed.epoch || 0),
            createdAt: String(parsed.createdAt || '').trim(),
            updatedAt: String(parsed.updatedAt || '').trim(),
            config: { ...candidateConfig, ...stripRuntimeFields((parsed.config || {}) as AnyRecord) },
          })
        }
      } catch (_: unknown) {
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
        const parsed = JSON.parse(raw) as AnyRecord
        if (parsed && parsed.config) {
          const parsedProjectPath = normalizeProjectPath((parsed.config as AnyRecord).projectPath)
          const currentProjectPath = normalizeProjectPath(currentConfig.projectPath)
          if (name === sessionName && (!parsedProjectPath || parsedProjectPath === currentProjectPath)) {
            continue
          }
          configs.push({
            name,
            route: (parsed.route as string) || '',
            epoch: Number(parsed.epoch || 0),
            createdAt: String(parsed.createdAt || '').trim(),
            updatedAt: String(parsed.updatedAt || '').trim(),
            config: { ...stripRuntimeFields(currentConfig), ...stripRuntimeFields((parsed.config || {}) as AnyRecord), sessionDir: legacySessionDir },
          })
          seen.add(identity)
        }
      } catch (_: unknown) {
      }
    }
  }

  return configs
}

async function selectPort(preferredPort: string, range: { start: number; end: number }, reservedPorts: Set<number>, availabilityChecker: (port: number) => Promise<boolean>): Promise<string> {
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
    } catch (_: unknown) {
    }
  }

  throw new Error(`No free port available in range ${range.start}-${range.end}`)
}

/** WSL 下从稳定候选开始，只连接探测而不 bind。 */
async function selectUnprobedWslAutomationPort(
  reservedPorts: Set<number>,
  availabilityChecker: (port: number) => Promise<boolean> = isPortNotListening,
): Promise<string> {
  const { start, end } = AUTO_PORT_RANGE
  const size = end - start + 1
  for (let offset = 0; offset < size; offset += 1) {
    const port = start + ((WSL_PREFERRED_AUTO_PORT - start + offset) % size)
    if (reservedPorts.has(port)) {
      continue
    }
    try {
      if (await availabilityChecker(port)) {
        return String(port)
      }
    } catch (_: unknown) {
    }
  }
  throw new Error(`No free port available in range ${start}-${end}`)
}

async function assignPorts(config: AnyRecord = {}, otherConfigs: AnyRecord[] = [], availabilityChecker?: (port: number) => Promise<boolean>): Promise<AnyRecord> {
  validateSessionPortConflicts(config, otherConfigs)

  const reservedAutoPorts = new Set<number>()
  for (const item of otherConfigs) {
    const otherConfig = (item && item.config ? item.config : item) as AnyRecord
    const autoPort = Number(otherConfig && otherConfig.autoPort)
    if (autoPort) {
      reservedAutoPorts.add(autoPort)
    }
    const devtoolsPort = Number(otherConfig && otherConfig.devtoolsPort)
    if (devtoolsPort) {
      reservedAutoPorts.add(devtoolsPort)
    }
  }

  const nextConfig: AnyRecord = { ...config }
  nextConfig.devtoolsPort = normalizePort(nextConfig.devtoolsPort)
  if (nextConfig.devtoolsPort) {
    reservedAutoPorts.add(Number(nextConfig.devtoolsPort))
  }
  const effectiveAvailabilityChecker = availabilityChecker
    || ((port: number) => isAutomationPortAvailable(port, nextConfig))
  const preferredAutoPort = normalizePort(nextConfig.autoPort)
  const shouldAvoidWslPrebind = !preferredAutoPort
    && Boolean(String(nextConfig.cliPath || '').trim())
    && resolveEnvironment(nextConfig).isWsl
  nextConfig.autoPort = shouldAvoidWslPrebind
    ? await selectUnprobedWslAutomationPort(reservedAutoPorts, effectiveAvailabilityChecker)
    : await selectPort(preferredAutoPort, AUTO_PORT_RANGE, reservedAutoPorts, effectiveAvailabilityChecker)
  return nextConfig
}

interface PortResolution {
  autoPortAssigned: boolean
  devtoolsPortAssigned: boolean
}

interface CreateSessionStateInput {
  sessionName: string
  config: AnyRecord
}

function createEmptySessionState({ sessionName, config }: CreateSessionStateInput): AnyRecord {
  const now = new Date().toISOString()
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
    createdAt: now,
    updatedAt: now,
  }
}

async function ensureSessionPorts(state: AnyRecord, availabilityChecker?: (port: number) => Promise<boolean>): Promise<AnyRecord> {
  const stateConfig = state.config as AnyRecord
  const needsAutoPort = !normalizePort(stateConfig.autoPort)

  state.portResolution = {
    autoPortAssigned: false,
    devtoolsPortAssigned: false,
  } as PortResolution

  if (!stateConfig.legacySessionDir && stateConfig.sessionDir) {
    stateConfig.legacySessionDir = stateConfig.sessionDir
  }
  stateConfig.projectPath = normalizeProjectPath(stateConfig.projectPath)
  stateConfig.sessionDir = resolveSessionDir(stateConfig)

  if (!needsAutoPort) {
    stateConfig.devtoolsPort = normalizePort(stateConfig.devtoolsPort)
    stateConfig.autoPort = normalizePort(stateConfig.autoPort)
    return state
  }

  const otherConfigs = await loadOtherSessionConfigs(stateConfig, state.name as string)
  state.config = await assignPorts(stateConfig, otherConfigs, availabilityChecker)
  const portResolution = state.portResolution as PortResolution
  portResolution.devtoolsPortAssigned = false
  portResolution.autoPortAssigned = needsAutoPort
  return state
}

function sessionFilePath(name: string, config: AnyRecord = {}): string {
  return path.join(resolveSessionDir(config), `${name}.json`)
}

function sessionLockRoot(config: AnyRecord = {}): string {
  if (normalizeProjectPath(config && config.projectPath)) {
    return path.join(projectStateRoot(config), 'locks')
  }
  const repoKey = createHash('sha1')
    .update(String((config && (config.repoRoot || config.sessionDir)) || 'default'))
    .digest('hex')
    .slice(0, 12)
  return path.join(os.tmpdir(), 'miniprogram-browser-locks', repoKey)
}

function sessionLockPath(name: string, config: AnyRecord = {}): string {
  return path.join(sessionLockRoot(config), `${name}.lock`)
}

function runtimeLockName(config: Record<string, unknown> = {}): string {
  const autoPort = normalizePort(config && config.autoPort)
  if (!autoPort) {
    return ''
  }
  return `__runtime_auto_${autoPort}`
}

/**
 * 选择可附着的 live runtime。
 * 多条 session 记录若共享同一 autoPort，视为**同一底层 runtime**（多工作台附着）。
 * 多个不同 live autoPort 且没有显式 session 时返回 ambiguous，禁止按时间猜测目标。
 */
function selectAttachableRuntimeSession(
  sessions: {
    status?: string
    autoPort?: string
    name?: string
    sessionName?: string
    projectPath?: string
    route?: string
    devtoolsPort?: string
    createdAt?: string
    updatedAt?: string
  }[] = [],
  preferredSessionName = '',
): { mode: 'none' | 'attach' | 'ambiguous'; session?: AnyRecord; sessions?: AnyRecord[] } {
  const liveSessions = (sessions || []).filter((item: AnyRecord) => item && item.status === 'live' && item.autoPort)
  const preferred = String(preferredSessionName || '').trim()
  if (preferred) {
    const ownSessions = liveSessions.filter((item: AnyRecord) => {
      const name = String(item.name || item.sessionName || '').trim()
      return name === preferred
    })
    // 同名 session 的 live runtime 优先；同名多条时取列表首项（调用方应已按 updatedAt 降序）
    if (ownSessions.length >= 1) {
      return {
        mode: 'attach',
        session: ownSessions[0],
      }
    }
  }

  // 按 autoPort 去重：同 port 多条 launch/session 只算一个 runtime
  const byPort = new Map<string, AnyRecord>()
  for (const item of liveSessions) {
    const port = String(item.autoPort || '').trim()
    if (!port || byPort.has(port)) {
      continue
    }
    byPort.set(port, item)
  }
  const uniqueRuntimes = [...byPort.values()]

  if (uniqueRuntimes.length === 0) {
    return {
      mode: 'none',
      sessions: [],
    }
  }
  // 只有一个底层 runtime 时可以无歧义复用；多个 runtime 必须让调用方展示候选。
  if (uniqueRuntimes.length > 1) {
    uniqueRuntimes.sort((a, b) => {
      const nameA = String(a.name || a.sessionName || '').trim()
      const nameB = String(b.name || b.sessionName || '').trim()
      return nameA.localeCompare(nameB)
    })
    return {
      mode: 'ambiguous',
      sessions: uniqueRuntimes,
    }
  }
  return {
    mode: 'attach',
    session: uniqueRuntimes[0],
  }
}

/**
 * 从 runtime 池为 session 选择应回绑的 live launch。
 * 优先级：同 sessionName > 同项目唯一 live autoPort（同 port 多条 launch 算一个 runtime）。
 * 不负责探测 endpoint 是否可达（由调用方做）。
 */
function selectRuntimeLaunchForSession(
  launches: AnyRecord[] = [],
  sessionName = '',
  projectPath = '',
): AnyRecord | null {
  const resolvedProject = projectPath ? path.resolve(projectPath) : ''
  if (!resolvedProject) {
    return null
  }

  const sameProjectLive = (launches || []).filter((item: AnyRecord) => {
    if (!item || item.status !== 'live' || !item.autoPort) {
      return false
    }
    const itemProject = item.projectPath ? path.resolve(String(item.projectPath)) : ''
    return itemProject === resolvedProject
  })

  const preferred = String(sessionName || '').trim()
  if (preferred) {
    const own = sameProjectLive.filter((item: AnyRecord) => String(item.sessionName || '').trim() === preferred)
    if (own.length >= 1) {
      return own[0]
    }
  }

  // 同 port 去重后再判断是否「唯一 runtime」
  const byPort = new Map<string, AnyRecord>()
  for (const item of sameProjectLive) {
    const port = String(item.autoPort || '').trim()
    if (!port || byPort.has(port)) {
      continue
    }
    byPort.set(port, item)
  }
  if (byPort.size === 1) {
    return [...byPort.values()][0]
  }

  return null
}

function shouldShutdownRuntimeOnClose(state: AnyRecord, options: AnyRecord = {}): boolean {
  if (options.runtime) {
    return true
  }
  return !Boolean(state && state.runtimeAttached)
}

function sessionLockMetaPath(lockPath: string): string {
  return path.join(lockPath, 'meta.json')
}

function isProcessAlive(pid: unknown): boolean {
  if (!Number.isInteger(pid) || (pid as number) <= 0) {
    return false
  }

  if (pid === process.pid) {
    return true
  }

  try {
    process.kill(pid as number, 0)
    return true
  } catch (error: unknown) {
    return Boolean(error && (error as NodeJS.ErrnoException).code === 'EPERM')
  }
}

async function readLockMeta(lockPath: string): Promise<AnyRecord | null> {
  try {
    return JSON.parse(await readFile(sessionLockMetaPath(lockPath), 'utf8'))
  } catch (_: unknown) {
    return null
  }
}

async function writeLockMeta(lockPath: string, meta: AnyRecord): Promise<void> {
  await writeFile(sessionLockMetaPath(lockPath), JSON.stringify(meta))
}

async function shouldReclaimStaleLock(lockPath: string, options: AnyRecord = {}): Promise<boolean> {
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
  } catch (_: unknown) {
    return false
  }
}

async function acquireSessionLock(sessionName: string, config: AnyRecord = {}, options: AnyRecord = {}): Promise<LockHandle> {
  const timeoutMs = Number(options.timeoutMs || process.env.MINIPROGRAM_BROWSER_LOCK_TIMEOUT_MS || 120000)
  const pollMs = Number(options.pollMs || 100)
  const heartbeatMs = Number(options.heartbeatMs || 2000)
  const lockPath = sessionLockPath(sessionName, config)
  const startedAt = Date.now()

  await mkdir(sessionLockRoot(config), { recursive: true })

  while (Date.now() - startedAt <= timeoutMs) {
    try {
      await mkdir(lockPath)
      const meta: AnyRecord = {
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
    } catch (error: unknown) {
      const err = error as NodeJS.ErrnoException
      if (!error || err.code !== 'EEXIST') {
        throw error
      }

      if (await shouldReclaimStaleLock(lockPath, options)) {
        await rm(lockPath, { recursive: true, force: true })
        continue
      }
      await new Promise<void>((resolve) => setTimeout(resolve, pollMs))
    }
  }

  const meta = await readLockMeta(lockPath)
  if (meta) {
    const parts: string[] = []
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

async function releaseSessionLock(lock: LockHandle | null | undefined): Promise<void> {
  if (!lock || !lock.path) {
    return
  }

  if (lock.heartbeatTimer) {
    clearInterval(lock.heartbeatTimer)
  }

  await rm(lock.path, { recursive: true, force: true })
}

async function loadSessionState(sessionName: string, config: AnyRecord = {}): Promise<AnyRecord> {
  const resolvedConfig = await resolveSessionConfig(sessionName, config)
  const filePath = sessionFilePath(sessionName, resolvedConfig)

  if (!existsSync(filePath)) {
    return createEmptySessionState({ sessionName, config: resolvedConfig })
  }

  const raw = await readFile(filePath, 'utf8')
  const parsed = JSON.parse(raw) as AnyRecord
  // 忽略旧的 session 文件中残留的运行时字段，每次 open/connect 重新分配
  const mergedConfig: AnyRecord = { ...resolvedConfig, ...stripRuntimeFields(parsed.config as AnyRecord || {}) }
  mergedConfig.projectPath = normalizeProjectPath(mergedConfig.projectPath)
  mergedConfig.sessionDir = resolveSessionDir(mergedConfig)
  delete mergedConfig.interactiveSelectors
  return {
    ...createEmptySessionState({ sessionName, config: resolvedConfig }),
    ...parsed,
    name: sessionName,
    bound: true,
    config: mergedConfig,
    refs: (parsed.refs as AnyRecord) || {},
    stableKeyToRef: (parsed.stableKeyToRef as AnyRecord) || {},
    lastSnapshot: Array.isArray(parsed.lastSnapshot) ? parsed.lastSnapshot : [],
    consoleEvents: Array.isArray(parsed.consoleEvents) ? parsed.consoleEvents : [],
    exceptionEvents: Array.isArray(parsed.exceptionEvents) ? parsed.exceptionEvents : [],
    routeEvents: Array.isArray(parsed.routeEvents) ? parsed.routeEvents : [],
    lastRouteEventSeq: Number(parsed.lastRouteEventSeq || 0),
    lastVisualProbe: parsed.lastVisualProbe || null,
    pendingVisualAction: parsed.pendingVisualAction || null,
  }
}

async function saveSessionState(state: AnyRecord): Promise<void> {
  const stateConfig = state.config as AnyRecord
  stateConfig.projectPath = normalizeProjectPath(stateConfig.projectPath)
  stateConfig.sessionDir = resolveSessionDir(stateConfig)
  await mkdir(stateConfig.sessionDir, { recursive: true })
  const prepared = prepareSessionStateForSave(state)
  await writeFile(sessionFilePath(state.name as string, stateConfig), JSON.stringify(prepared, null, 2))
  await registerSessionProject(state.name as string, stateConfig)
}

interface SaveOptions {
  maxInactiveRefs?: number
  maxRuntimeEvents?: number
  maxRouteEvents?: number
}

function prepareSessionStateForSave(state: AnyRecord, options: SaveOptions = {}): AnyRecord {
  const maxInactiveRefs = Number(options.maxInactiveRefs || DEFAULT_MAX_INACTIVE_REFS)
  const maxRuntimeEvents = Number(options.maxRuntimeEvents || DEFAULT_MAX_RUNTIME_EVENTS)
  const maxRouteEvents = Number(options.maxRouteEvents || DEFAULT_MAX_ROUTE_EVENTS)
  const refs: AnyRecord = { ...((state.refs as AnyRecord) || {}) }
  const stableKeyToRef: AnyRecord = { ...((state.stableKeyToRef as AnyRecord) || {}) }

  const inactiveEntries = Object.entries(refs)
    .filter(([_, record]: [string, unknown]) => {
      const rec = record as AnyRecord
      return rec && rec.active === false
    })
    .sort(([_, left]: [string, unknown], [__, right]: [string, unknown]) => {
      const l = left as AnyRecord
      const r = right as AnyRecord
      return Number((l && l.lastSeenEpoch) || 0) - Number((r && r.lastSeenEpoch) || 0)
    })

  while (inactiveEntries.length > maxInactiveRefs) {
    const [ref, record] = inactiveEntries.shift() as [string, AnyRecord]
    delete refs[ref]
    const stableKey = record && (record.stableKey as string)
    if (stableKey && stableKeyToRef[stableKey] === ref) {
      delete stableKeyToRef[stableKey]
    }
  }

  const consoleEvents = Array.isArray(state.consoleEvents)
    ? (state.consoleEvents as unknown[]).slice(-maxRuntimeEvents)
    : []
  const exceptionEvents = Array.isArray(state.exceptionEvents)
    ? (state.exceptionEvents as unknown[]).slice(-maxRuntimeEvents)
    : []
  const routeEvents = Array.isArray(state.routeEvents)
    ? (state.routeEvents as unknown[]).slice(-maxRouteEvents)
    : []

  const now = new Date().toISOString()
  const createdAt = String(state.createdAt || '').trim() || now
  return {
    ...state,
    refs,
    stableKeyToRef,
    config: stripRuntimeFields(state.config as AnyRecord),
    consoleEvents,
    exceptionEvents,
    routeEvents,
    lastVisualProbe: state.lastVisualProbe || null,
    pendingVisualAction: state.pendingVisualAction || null,
    createdAt,
    updatedAt: now,
  }
}

/**
 * 移除 config 中运行时分配的资源字段，不持久化到 session 文件。
 * 这些字段在每次 open/connect 时重新分配。
 */
function stripRuntimeFields(config: AnyRecord): AnyRecord {
  const cleaned = { ...config }
  delete cleaned.autoPort
  delete cleaned.devtoolsPort
  delete cleaned.devtoolsProjectAutoLink
  delete cleaned.devtoolsProjectMirror
  return cleaned
}

interface SessionListEntry {
  name: string
  projectPath: string
  devtoolsProjectPath: string
  devtoolsPort: string
  autoPort: string
  runtimeAttached: boolean
  runtimeOwnerSession: string
  route: string
  epoch: number
  createdAt: string
  updatedAt: string
}

async function listSessionStates(sessionDirOrConfig: AnyRecord | string): Promise<SessionListEntry[]> {
  if (typeof sessionDirOrConfig === 'object' && sessionDirOrConfig) {
    const otherConfigs = await loadOtherSessionConfigs(sessionDirOrConfig as AnyRecord, '')
    return otherConfigs
      .map((item: OtherSessionInfo) => ({
        name: item.name,
        projectPath: item.config && item.config.projectPath ? String(item.config.projectPath) : '',
        devtoolsProjectPath: item.config && item.config.devtoolsProjectPath ? String(item.config.devtoolsProjectPath) : '',
        devtoolsPort: item.config && item.config.devtoolsPort ? String(item.config.devtoolsPort) : '',
        autoPort: item.config && item.config.autoPort ? String(item.config.autoPort) : '',
        runtimeAttached: Boolean(item.runtimeAttached),
        runtimeOwnerSession: (item.runtimeOwnerSession as string) || '',
        route: item.route || '',
        epoch: Number(item.epoch || 0),
        createdAt: String(item.createdAt || '').trim(),
        updatedAt: String(item.updatedAt || '').trim(),
      }))
      .sort((left: SessionListEntry, right: SessionListEntry) => left.name.localeCompare(right.name))
  }

  const sessionDir = String(sessionDirOrConfig)

  if (!existsSync(sessionDir)) {
    return []
  }

  const entries = await readdir(sessionDir, { withFileTypes: true })
  const states: SessionListEntry[] = []

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue
    }

    try {
      const raw = await readFile(path.join(sessionDir, entry.name), 'utf8')
      const parsed = JSON.parse(raw) as AnyRecord
      const name = (parsed.name as string) || entry.name.slice(0, -'.json'.length)
      const parsedConfig = (parsed.config || {}) as AnyRecord
      states.push({
        name,
        projectPath: parsedConfig.projectPath ? String(parsedConfig.projectPath) : '',
        devtoolsProjectPath: parsedConfig.devtoolsProjectPath ? String(parsedConfig.devtoolsProjectPath) : '',
        devtoolsPort: parsedConfig.devtoolsPort ? String(parsedConfig.devtoolsPort) : '',
        autoPort: parsedConfig.autoPort ? String(parsedConfig.autoPort) : '',
        runtimeAttached: Boolean(parsed.runtimeAttached),
        runtimeOwnerSession: (parsed.runtimeOwnerSession as string) || '',
        route: (parsed.route as string) || '',
        epoch: Number(parsed.epoch || 0),
        createdAt: String(parsed.createdAt || '').trim(),
        updatedAt: String(parsed.updatedAt || '').trim(),
      })
    } catch (_: unknown) {
    }
  }

  return states.sort((left: SessionListEntry, right: SessionListEntry) => left.name.localeCompare(right.name))
}

async function clearSessionState(sessionName: string, config: AnyRecord = {}): Promise<void> {
  const resolvedConfig = await resolveSessionConfig(sessionName, config)
  await rm(sessionFilePath(sessionName, resolvedConfig), { force: true })
  await unregisterSessionProject(sessionName, resolvedConfig)
  await clearActiveSession(sessionName, resolvedConfig)
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
  isAutomationPortAvailable,
  selectUnprobedWslAutomationPort,
  ensureSessionPorts,
  acquireSessionLock,
  releaseSessionLock,
  prepareSessionStateForSave,
  listSessionStates,
  loadOtherSessionConfigs,
  listRuntimeLaunches,
  getActiveSession,
  setActiveSession,
  clearActiveSession,
  reconcileRuntimeLaunches,
  isEphemeralNoiseSessionName,
  runtimeLockName,
  recordRuntimeLaunch,
  updateRuntimeLaunch,
  removeRuntimeLaunch,
  selectAttachableRuntimeSession,
  selectRuntimeLaunchForSession,
  shouldShutdownRuntimeOnClose,
  sessionLockRoot,
  sessionLockPath,
  resolveSessionConfig,
  loadSessionState,
  saveSessionState,
  clearSessionState,
  projectSessionSlug,
  isAutoProjectSessionName,
  pickAutoProjectSessionName,
  nextAutoProjectSessionName,
}
