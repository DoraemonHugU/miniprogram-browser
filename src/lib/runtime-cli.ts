const { existsSync, statSync, constants, accessSync } = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const { resolveEnvironment } = require('./platform')
const {
  toWindowsPath,
  isWslUncPath,
  runWindowsCommand,
} = require('./runtime-windows')
const {
  parseAutomationCliFailure,
  parseResolvedIdePort,
  detectAutomationStartupIssue,
  detectAutomationCliProgressTimeout,
} = require('./runtime-cli-shared')

type AnyRecord = Record<string, any>
type ErrorWithMeta = Error & AnyRecord

// ---- 项目映射辅助函数 ----

function normalizeProjectMapLinuxPrefix(prefix) {
  const normalized = path.posix.normalize(String(prefix || '').trim().replace(/\\/gu, '/'))
  if (!normalized || normalized === '.' || !normalized.startsWith('/')) {
    throw new Error('Invalid project map. Use --project-map <linux=windows> or WECHAT_DEVTOOLS_PROJECT_MAP, for example /home/wang/xuexi/projects=P:\\projects.')
  }
  return normalized === '/' ? normalized : normalized.replace(/\/+$/u, '')
}

function normalizeProjectMapWindowsPrefix(prefix) {
  let normalized = String(prefix || '').trim().replace(/\//gu, '\\').replace(/\\+$/u, '')
  normalized = normalized.replace(/^([a-z]):/iu, (_match, drive) => `${String(drive).toUpperCase()}:`)
  return normalized
}

function parseProjectMapEntries(rawMap) {
  const entries = []
  if (!rawMap) {
    return entries
  }
  for (const segment of String(rawMap).split(/;/u)) {
    const trimmed = segment.trim()
    if (!trimmed) {
      continue
    }
    const eqIndex = trimmed.indexOf('=')
    if (eqIndex < 1) {
      throw new Error(`Invalid project map entry: ${trimmed}. Use --project-map <linux=windows> or WECHAT_DEVTOOLS_PROJECT_MAP, for example /home/wang/xuexi/projects=P:\\projects.`)
    }
    entries.push({
      linuxPrefix: normalizeProjectMapLinuxPrefix(trimmed.slice(0, eqIndex)),
      windowsPrefix: normalizeProjectMapWindowsPrefix(trimmed.slice(eqIndex + 1)),
    })
  }
  return entries
}

function matchesProjectMapPrefix(sourcePath, linuxPrefix) {
  const normalizedSource = path.posix.normalize(String(sourcePath || '').trim().replace(/\\/gu, '/'))
  return normalizedSource === linuxPrefix || normalizedSource.startsWith(`${linuxPrefix}/`)
}

function resolveMappedDevtoolsProjectPath(sourcePath, rawMap) {
  if (!sourcePath || !rawMap) {
    return ''
  }
  const entries = parseProjectMapEntries(rawMap)
  let bestMatch = ''
  let bestPrefix = ''
  for (const entry of entries) {
    if (!matchesProjectMapPrefix(sourcePath, entry.linuxPrefix)) {
      continue
    }
    if (entry.linuxPrefix.length > bestPrefix.length) {
      bestPrefix = entry.linuxPrefix
      const mapped = entry.windowsPrefix + sourcePath.slice(entry.linuxPrefix.length).replace(/\//gu, '\\')
      bestMatch = mapped
    }
  }
  return bestMatch
}

function assertSupportedDevtoolsProjectPath(projectPath) {
  if (!isWslUncPath(projectPath)) {
    return
  }

  throw new Error('WSL UNC project path is not accepted by WeChat DevTools CLI, and miniprogram-browser could not create a managed Windows temp mirror for it. Put the project under /mnt/<drive>/..., pass --devtools-project <Windows drive path> / WECHAT_DEVTOOLS_PROJECT, or configure --project-map <linux=windows> / WECHAT_DEVTOOLS_PROJECT_MAP when you have a mapped drive.')
}

// ---- DevTools 项目路径解析 ----

function resolveDevtoolsProjectPath(config, options: AnyRecord = {}) {
  const converter = options.toWindowsPath || toWindowsPath
  const explicitPath = String((config && config.devtoolsProjectPath) || '').trim()
  const projectPath = String((config && config.projectPath) || '').trim()
  const sourcePath = explicitPath || projectPath

  if (!sourcePath) {
    return ''
  }

  const hasWindowsBundle = resolveEnvironment(config, options).devtoolsHost === 'win32'
  let devtoolsProjectPath = sourcePath

  if (hasWindowsBundle) {
    if (!explicitPath) {
      const mappedPath = resolveMappedDevtoolsProjectPath(projectPath, config && config.devtoolsProjectMap)
      if (mappedPath) {
        devtoolsProjectPath = mappedPath
      }
    }

    if (devtoolsProjectPath === sourcePath && sourcePath.startsWith('/')) {
      devtoolsProjectPath = converter(sourcePath)
    }

    if (!explicitPath && isWslUncPath(devtoolsProjectPath)) {
      const { resolveWindowsManagedProjectPath } = require('./runtime-windows')
      const mappedPath = resolveWindowsManagedProjectPath(devtoolsProjectPath, config, options)
      if (mappedPath) {
        devtoolsProjectPath = mappedPath
      }
    }
  }

  assertSupportedDevtoolsProjectPath(devtoolsProjectPath)
  return devtoolsProjectPath
}

// ---- 构建 CLI 参数 ----

function buildAutomationArgs(config, options: AnyRecord = {}) {
  const explicitProjectPath = String((config && config.devtoolsProjectPath) || '').trim()
  const hasProjectMap = Boolean(String((config && config.devtoolsProjectMap) || '').trim())
  const devtoolsProjectPath = resolveDevtoolsProjectPath(config, options)
  const env = resolveEnvironment(config, options)
  // 由 env 推导 windows 包标志，与 runtime 单源一致（WSL 恒为 win32 桥接），
  // 不再依赖 cliPath 是否 .bat 的脆弱判断。
  const hasWindowsBundle = env.devtoolsHost === 'win32'
  let projectStrategy = 'direct'
  if (config.devtoolsProjectMirror) {
    projectStrategy = 'managed-mirror'
  } else if (config.devtoolsProjectAutoLink) {
    projectStrategy = 'managed-link'
  } else if (explicitProjectPath) {
    projectStrategy = 'explicit'
  } else if (hasProjectMap) {
    projectStrategy = 'project-map'
  } else if (env.isWsl && String(config.projectPath || '').startsWith('/mnt/')) {
    projectStrategy = 'wsl-mounted-drive'
  }
  const args = [
    'auto',
    '--project',
    devtoolsProjectPath,
    '--auto-port',
    String(config.autoPort),
  ]

  if (config.trustProject) {
    args.push('--trust-project')
  }

  if (String(config.devtoolsPort || '').trim()) {
    args.push('--port', String(config.devtoolsPort))
  }

  // Keep debug output enabled for automation startup. Current DevTools builds
  // still hide useful startup facts there even though "ws connect" belongs to
  // the CLI /upgrade long connection rather than the automation endpoint.
  args.push('--debug')

  return {
    hasWindowsBundle,
    args,
    devtoolsProjectPath,
    projectStrategy,
  }
}

function buildDevtoolsOpenArgs(config, options: AnyRecord = {}) {
  const automationArgs = buildAutomationArgs(config, options)
  const args = [
    'open',
    '--project',
    automationArgs.devtoolsProjectPath,
  ]

  if (String(config.devtoolsPort || '').trim()) {
    args.push('--port', String(config.devtoolsPort))
  }

  return {
    args,
    devtoolsProjectPath: automationArgs.devtoolsProjectPath,
    projectStrategy: automationArgs.projectStrategy,
  }
}

// ---- CLI 验证与运行 ----

function normalizeCliPath(rawPath) {
  const trimmed = String(rawPath || '').trim()
  if (!trimmed) {
    return ''
  }

  const statInfo = existsSync(trimmed) ? statSync(trimmed) : null
  // 如果指向目录，补全 cli.js
  if (statInfo && statInfo.isDirectory()) {
    const cliJs = path.join(trimmed, 'cli.js')
    if (existsSync(cliJs)) {
      return cliJs
    }
    return trimmed
  }

  // 如果指向 .bat，归一化为同目录 cli.js
  if (/\.bat$/iu.test(trimmed)) {
    const dirName = path.dirname(trimmed)
    const cliJs = path.join(dirName, 'cli.js')
    if (existsSync(cliJs)) {
      return cliJs
    }
  }

  return trimmed
}

function validateAutomationCliConfig(config, options: AnyRecord = {}) {
  const rawPath = String((config && config.cliPath) || '').trim()
  if (!rawPath) {
    const error = new Error('Missing WeChat DevTools CLI path. Set WECHAT_DEVTOOLS_CLI or pass --cli-path <path>.') as ErrorWithMeta
    error.code = 'DEVTOOLS_CLI_ERROR'
    throw error
  }

  // 归一化：.bat→.js、目录→cli.js
  const normalizedPath = normalizeCliPath(rawPath)
  if (normalizedPath !== rawPath) {
    config.cliPath = normalizedPath
  }

  const cliPath = String((config && config.cliPath) || '').trim()
  if (!cliPath) {
    const error = new Error('Missing WeChat DevTools CLI path after normalization. Set WECHAT_DEVTOOLS_CLI or pass --cli-path <path>.') as ErrorWithMeta
    error.code = 'DEVTOOLS_CLI_ERROR'
    throw error
  }

  if (!existsSync(cliPath)) {
    const error = new Error(`WeChat DevTools CLI not found: ${cliPath}. Set WECHAT_DEVTOOLS_CLI or pass --cli-path <path>.`) as ErrorWithMeta
    error.code = 'DEVTOOLS_CLI_ERROR'
    throw error
  }

  if (!statSync(cliPath).isFile()) {
    const error = new Error(`WeChat DevTools CLI path is not a file: ${cliPath}.`) as ErrorWithMeta
    error.code = 'DEVTOOLS_CLI_ERROR'
    throw error
  }

  const hasWindowsBundle = resolveEnvironment(config, options).devtoolsHost === 'win32'
  if (hasWindowsBundle) {
    const cliDirectory = path.dirname(cliPath)
    const nodeExePath = path.join(cliDirectory, 'node.exe')
    if (!existsSync(nodeExePath)) {
      throw new Error(`WeChat DevTools CLI bundle is incomplete near ${cliPath}; expected node.exe next to cli.js.`)
    }
    return
  }

  if (process.platform !== 'win32') {
    try {
      accessSync(cliPath, constants.X_OK)
    } catch (_) {
      throw new Error(`WeChat DevTools CLI is not executable: ${cliPath}.`)
    }
  }
}

function runDevtoolsCli(config, args, options: AnyRecord = {}) {
  validateAutomationCliConfig(config, options)
  const cliDirectory = path.dirname(config.cliPath)
  const hasWindowsBundle = resolveEnvironment(config, options).devtoolsHost === 'win32'
  const timeoutMs = Number(options.timeoutMs || 30000)

  // cliPath 经过 normalizeCliPath 已统一为 cli.js，但 Windows node.exe
  // 不认 /mnt/ 路径，需转成 Windows 格式。
  const cliJsArg = hasWindowsBundle ? toWindowsPath(config.cliPath) : config.cliPath

  const result = hasWindowsBundle
    ? spawnSync(path.join(cliDirectory, 'node.exe'), [
      cliJsArg,
      ...args,
    ], {
      cwd: cliDirectory,
      encoding: 'utf8',
      timeout: timeoutMs,
    })
    : spawnSync(config.cliPath, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
    })

  return {
    ...result,
    raw: `${result.stdout || ''}${result.stderr || ''}`.trim(),
  }
}

function runAutomationCli(config, options: AnyRecord = {}) {
  const { args } = buildAutomationArgs(config, options)
  return runDevtoolsCli(config, args, options)
}

function openDevtoolsProject(config, options: AnyRecord = {}) {
  const { args, devtoolsProjectPath, projectStrategy } = buildDevtoolsOpenArgs(config, options)
  const result = runDevtoolsCli(config, args, { timeoutMs: Number(options.timeoutMs || 30000), ...options })
  const failure = parseAutomationCliFailure(result, config)
  if (failure) {
    const normalizedFailure = failure as AnyRecord
    return {
      attempted: true,
      ok: false,
      devtoolsProjectPath,
      projectStrategy,
      raw: failure.raw || result.raw,
      error: failure.message,
      code: normalizedFailure.code || 'DEVTOOLS_CLI_ERROR',
      hint: normalizedFailure.hint,
    }
  }

  const resolvedDevtoolsPort = parseResolvedIdePort(result.raw)
  if (!String(config.devtoolsPort || '').trim() && resolvedDevtoolsPort) {
    config.devtoolsPort = resolvedDevtoolsPort
  }

  return {
    attempted: true,
    ok: true,
    devtoolsProjectPath,
    projectStrategy,
    resolvedDevtoolsPort,
    raw: result.raw,
  }
}

function resolveDevtoolsProjectPathForClose(config, options: AnyRecord = {}) {
  const explicitPath = String((config && config.devtoolsProjectPath) || '').trim()
  if (explicitPath) {
    return explicitPath
  }

  const projectPath = String((config && config.projectPath) || '').trim()
  if (!projectPath) {
    return ''
  }

  const hasWindowsBundle = resolveEnvironment(config, options).devtoolsHost === 'win32'
  if (!hasWindowsBundle) {
    return projectPath
  }

  let windowsProjectPath = projectPath
  if (projectPath.startsWith('/')) {
    try {
      windowsProjectPath = toWindowsPath(projectPath)
    } catch (_) {
      return ''
    }
  }

  return isWslUncPath(windowsProjectPath) ? '' : windowsProjectPath
}

function closeDevtoolsProject(config, options: AnyRecord = {}) {
  const projectPath = resolveDevtoolsProjectPathForClose(config, options)
  if (!projectPath) {
    return {
      attempted: false,
      ok: false,
      reason: 'missing-devtools-project-path',
    }
  }

  const args = ['close', '--project', projectPath]
  if (String((config && config.devtoolsPort) || '').trim()) {
    args.push('--port', String(config.devtoolsPort))
  }

  try {
    const result = runDevtoolsCli(config, args, { timeoutMs: options.timeoutMs || 30000, ...options })
    const failure = parseAutomationCliFailure(result, config)
    if (failure) {
      return {
        attempted: true,
        ok: false,
        projectPath,
        raw: failure.raw || result.raw,
        error: failure.message,
      }
    }
    return {
      attempted: true,
      ok: true,
      projectPath,
      raw: result.raw,
    }
  } catch (error) {
    return {
      attempted: true,
      ok: false,
      projectPath,
      error: error && error.message ? String(error.message) : String(error),
    }
  }
}

function enableAutomation(config, options: AnyRecord = {}) {
  const preOpen = openDevtoolsProject(config, options)
  if (preOpen && !preOpen.ok) {
    const error = new Error(preOpen.error || 'Failed to open WeChat DevTools project before automation startup') as ErrorWithMeta
    error.code = preOpen.code || 'DEVTOOLS_CLI_ERROR'
    error.hint = preOpen.hint
    error.raw = preOpen.raw
    throw error
  }

  const result = runAutomationCli(config, options)
  const startupIssue = detectAutomationStartupIssue(result.raw)
  const cliFailure = parseAutomationCliFailure(result, config)
  const progressTimeout = detectAutomationCliProgressTimeout(result)

  if (cliFailure && !progressTimeout) {
    const error = new Error(cliFailure.message) as ErrorWithMeta
    error.code = (cliFailure as AnyRecord).code || 'DEVTOOLS_CLI_ERROR'
    error.hint = (cliFailure as AnyRecord).hint
    error.raw = cliFailure.raw
    throw error
  }

  const resolvedDevtoolsPort = parseResolvedIdePort(result.raw) || (preOpen && preOpen.resolvedDevtoolsPort) || ''
  if (!String(config.devtoolsPort || '').trim() && resolvedDevtoolsPort) {
    config.devtoolsPort = resolvedDevtoolsPort
  }

  // DevTools debug output can include "ws connect <port>", but that port comes
  // from the CLI /upgrade long connection instead of the automation endpoint
  // requested through /auto. Do not rewrite the session autoPort from it.
  if (config && Object.prototype.hasOwnProperty.call(config, 'autoPortSource')) {
    delete config.autoPortSource
  }

  return {
    cliTimedOut: Boolean(progressTimeout),
    projectOpened: Boolean(preOpen && preOpen.ok),
    resolvedDevtoolsPort,
    startupIssue,
  }
}

module.exports = {
  normalizeProjectMapLinuxPrefix,
  normalizeProjectMapWindowsPrefix,
  parseProjectMapEntries,
  matchesProjectMapPrefix,
  resolveMappedDevtoolsProjectPath,
  assertSupportedDevtoolsProjectPath,
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
}
