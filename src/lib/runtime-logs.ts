const { createHash } = require('node:crypto')
const path = require('node:path')
const { readFile, readdir, stat } = require('node:fs/promises')
const { existsSync, readFileSync } = require('node:fs')
const { spawnSync } = require('node:child_process')

const { resolveEnvironment, usesWindowsDevtoolsBundle } = require('./platform')
const { normalizeWindowsPathForCompare, toWindowsPath, runWindowsCommand } = require('./runtime-windows')

function windowsPathToWslPath(inputPath: string): string {
  const normalized = String(inputPath || '').trim()
  if (!normalized) {
    return ''
  }
  const result = spawnSync('wslpath', ['-u', normalized], { encoding: 'utf8' })
  if (result.status !== 0) {
    return ''
  }
  return result.stdout.trim()
}

function resolveWindowsLocalAppData(runCommand = runWindowsCommand) {
  const result = runCommand('echo %LOCALAPPDATA%')
  if (!result || result.status !== 0) {
    return ''
  }
  const lines = String(result.stdout || '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
  return lines.reverse().find((line) => /^[a-z]:\\/iu.test(line)) || ''
}

function resolveDevtoolsLogRoot(config: Record<string, unknown>, options: Record<string, unknown> = {}) {
  const cliPath = String((config && config.cliPath) || '').trim()
  if (!cliPath) {
    throw new Error('Missing WeChat DevTools CLI path. Set WECHAT_DEVTOOLS_CLI or pass --cli-path <path>.')
  }

  const cliDirectory = path.dirname(cliPath)
  const env = resolveEnvironment(config, options)
  const hasWindowsBundle = usesWindowsDevtoolsBundle(env)
  if (hasWindowsBundle) {
    const installPath = (options.toWindowsPath as (s: string) => string || toWindowsPath)(cliDirectory)
    const productHash = createHash('md5').update(installPath).digest('hex')
    const localAppData = options.localAppData || resolveWindowsLocalAppData(runWindowsCommand)
    if (!localAppData) {
      throw new Error('Unable to resolve Windows LOCALAPPDATA for DevTools logs.')
    }
    const logRootWin = path.win32.join(localAppData as string, '微信开发者工具', 'User Data', productHash, 'WeappLog')
    const logRoot = env.runtime === 'win32' ? logRootWin : (options.windowsPathToWslPath as (s: string) => string || windowsPathToWslPath)(logRootWin as string)
    if (!logRoot) {
      throw new Error(`Unable to convert DevTools log path: ${logRootWin}`)
    }
    return {
      installPath,
      productHash,
      logRoot,
      logRootNative: logRootWin,
      userDataRoot: path.dirname(path.dirname(logRoot)),
      userDataRootNative: path.win32.dirname(path.win32.dirname(logRootWin)),
    }
  }

  if (env.runtime === 'darwin') {
    const installPath = path.dirname(cliPath)
    const productHash = createHash('md5').update(installPath).digest('hex')
    const userDataRoot = path.join(
      String(options.homeDir || process.env.HOME || ''),
      'Library',
      'Application Support',
      '微信开发者工具',
    )
    return {
      installPath,
      productHash,
      logRoot: path.join(userDataRoot, productHash, 'WeappLog'),
      logRootNative: '',
      userDataRoot,
      discoveryStrategy: 'latest-log',
    }
  }

  throw new Error(
    `DevTools log discovery is only supported for Windows DevTools (from Windows or WSL) and macOS; ` +
    `current environment runtime=${env.runtime} devtoolsHost=${env.devtoolsHost}.`
  )
}

async function discoverActiveDevtoolsLogRoot(rootInfo: Record<string, unknown>): Promise<Record<string, unknown>> {
  const userDataRoot = rootInfo && rootInfo.userDataRoot
  const installPath = normalizeWindowsPathForCompare(rootInfo && rootInfo.installPath)
  if (!userDataRoot || !installPath) {
    return rootInfo
  }

  let best = null
  try {
    const entries = await readdir(userDataRoot, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue
      }
      const logRoot = path.join(userDataRoot, entry.name, 'WeappLog')
      if (rootInfo.discoveryStrategy === 'latest-log') {
        const logFiles = await listDevtoolsLogFiles(logRoot)
        let latestMtimeMs = 0
        for (const filePath of logFiles) {
          const info = await stat(filePath).catch(() => null)
          latestMtimeMs = Math.max(latestMtimeMs, Number(info && info.mtimeMs) || 0)
        }
        if (latestMtimeMs && (!best || latestMtimeMs > best.mtimeMs)) {
          best = {
            productHash: entry.name,
            logRoot,
            mtimeMs: latestMtimeMs,
          }
        }
        continue
      }

      const launchLog = path.join(logRoot, 'launch.log')
      let info
      let content
      try {
        info = await stat(launchLog)
        content = await readFile(launchLog, 'utf8')
      } catch (_) {
        continue
      }
      if (!normalizeWindowsPathForCompare(content).includes(installPath)) {
        continue
      }
      if (!best || info.mtimeMs > best.mtimeMs) {
        best = {
          productHash: entry.name,
          logRoot,
          mtimeMs: info.mtimeMs,
        }
      }
    }
  } catch (_) {}

  if (!best || best.productHash === rootInfo.productHash) {
    return rootInfo
  }

  return {
    ...rootInfo,
    productHash: best.productHash,
    logRoot: best.logRoot,
    logRootNative: rootInfo.logRootNative
      ? path.win32.join(path.win32.dirname(path.win32.dirname(rootInfo.logRootNative)), best.productHash, 'WeappLog')
      : '',
    discoveredFromLaunchLog: rootInfo.discoveryStrategy !== 'latest-log' || undefined,
    discoveredFromRecentLog: rootInfo.discoveryStrategy === 'latest-log' || undefined,
  }
}

async function listDevtoolsLogFiles(logRoot: string): Promise<string[]> {
  const files: string[] = []
  const directNames = ['launch.log', 'stdout.log', 'stderr.log', 'report.log']
  for (const name of directNames) {
    const filePath = path.join(logRoot, name)
    try {
      const info = await stat(filePath)
      if (info.isFile()) {
        files.push(filePath)
      }
    } catch (_) {}
  }

  const logsDir = path.join(logRoot, 'logs')
  try {
    const entries = await readdir(logsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.log')) {
        files.push(path.join(logsDir, entry.name))
      }
    }
  } catch (_) {}
  return files
}

function tailLogLines(content: unknown, limit: unknown, grepPattern: unknown): string[] {
  let lines = String(content || '').split(/\r?\n/u).filter((line) => line.length > 0)
  if (grepPattern) {
    const matcher = new RegExp(String(grepPattern), 'iu')
    lines = lines.filter((line) => matcher.test(line))
  }
  return lines.slice(Math.max(0, lines.length - Number(limit)))
}

async function collectDevtoolsLogs(config: Record<string, unknown>, options: Record<string, unknown> = {}) {
  const root = await discoverActiveDevtoolsLogRoot(resolveDevtoolsLogRoot(config, options))
  const lineLimit = Math.max(1, Number(options.limit || 80))
  const fileLimit = Math.max(1, Number(options.files || 4))
  const grepPattern = String(options.grep || '').trim()
  const files = []
  for (const filePath of await listDevtoolsLogFiles(String(root.logRoot))) {
    try {
      const info = await stat(filePath)
      files.push({
        path: filePath,
        mtimeMs: info.mtimeMs,
      })
    } catch (_) {}
  }

  files.sort((left, right) => right.mtimeMs - left.mtimeMs)
  const selectedFiles = files.slice(0, fileLimit)
  const entries = []
  for (const item of selectedFiles) {
    const content = await readFile(item.path, 'utf8').catch(() => '')
    entries.push({
      path: item.path,
      mtimeMs: item.mtimeMs,
      lines: tailLogLines(content, lineLimit, grepPattern),
    })
  }

  return {
    logRoot: root.logRoot,
    logRootNative: root.logRootNative,
    productHash: root.productHash,
    discovery: root.discoveredFromRecentLog
      ? 'latest-log'
      : root.discoveredFromLaunchLog
        ? 'launch-log'
        : 'default',
    files: entries,
  }
}

module.exports = {
  windowsPathToWslPath,
  resolveWindowsLocalAppData,
  resolveDevtoolsLogRoot,
  discoverActiveDevtoolsLogRoot,
  listDevtoolsLogFiles,
  tailLogLines,
  collectDevtoolsLogs,
}
