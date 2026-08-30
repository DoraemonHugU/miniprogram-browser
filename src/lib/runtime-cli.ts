const { existsSync, statSync, constants, accessSync } = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const { resolveEnvironment, usesWindowsDevtoolsBundle } = require('./platform')
const {
  toWindowsPath,
  isWslUncPath,
} = require('./runtime-windows')
const {
  parseAutomationCliFailure,
  parseResolvedIdePort,
  detectAutomationStartupIssue,
  detectAutomationCliProgressTimeout,
} = require('./runtime-cli-shared')

type AnyRecord = Record<string, unknown>
type ErrorWithMeta = Error & AnyRecord

// ---- 项目映射辅助函数 ----

function normalizeProjectMapLinuxPrefix(prefix: string): string {
  const normalized = path.posix.normalize(String(prefix || '').trim().replace(/\\/gu, '/'))
  if (!normalized || normalized === '.' || !normalized.startsWith('/')) {
    throw new Error('Invalid project map. Use --project-map <linux=windows> or WECHAT_DEVTOOLS_PROJECT_MAP, for example /home/developer/work=P:\\work.')
  }
  return normalized === '/' ? normalized : normalized.replace(/\/+$/u, '')
}

function normalizeProjectMapWindowsPrefix(prefix: string): string {
  let normalized = String(prefix || '').trim().replace(/\//gu, '\\').replace(/\\+$/u, '')
  normalized = normalized.replace(/^([a-z]):/iu, (_match, drive) => `${String(drive).toUpperCase()}:`)
  return normalized
}

function parseProjectMapEntries(rawMap: string): { linuxPrefix: string; windowsPrefix: string }[] {
  const entries: { linuxPrefix: string; windowsPrefix: string }[] = []
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
      throw new Error(`Invalid project map entry: ${trimmed}. Use --project-map <linux=windows> or WECHAT_DEVTOOLS_PROJECT_MAP, for example /home/developer/work=P:\\work.`)
    }
    entries.push({
      linuxPrefix: normalizeProjectMapLinuxPrefix(trimmed.slice(0, eqIndex)),
      windowsPrefix: normalizeProjectMapWindowsPrefix(trimmed.slice(eqIndex + 1)),
    })
  }
  return entries
}

function matchesProjectMapPrefix(sourcePath: string, linuxPrefix: string): boolean {
  const normalizedSource = path.posix.normalize(String(sourcePath || '').trim().replace(/\\/gu, '/'))
  return normalizedSource === linuxPrefix || normalizedSource.startsWith(`${linuxPrefix}/`)
}

function resolveMappedDevtoolsProjectPath(sourcePath: string, rawMap: string): string {
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

// ---- DevTools 项目路径解析 ----

function resolveDevtoolsProjectPath(config: AnyRecord, options: AnyRecord = {}): string {
  const converter = options.toWindowsPath || toWindowsPath
  const explicitPath = String((config && config.devtoolsProjectPath) || '').trim()
  const projectPath = String((config && config.projectPath) || '').trim()
  const sourcePath = explicitPath || projectPath

  if (!sourcePath) {
    return ''
  }

  const hasWindowsBundle = usesWindowsDevtoolsBundle(resolveEnvironment(config, options))
  let devtoolsProjectPath = sourcePath

  if (hasWindowsBundle) {
    if (!explicitPath) {
      const mappedPath = resolveMappedDevtoolsProjectPath(projectPath, String((config && config.devtoolsProjectMap) || ''))
      if (mappedPath) {
        devtoolsProjectPath = mappedPath
      }
    }

    if (devtoolsProjectPath === sourcePath && sourcePath.startsWith('/')) {
      devtoolsProjectPath = converter(sourcePath)
    }
  }

  return devtoolsProjectPath
}

// ---- 构建 CLI 参数 ----

function buildAutomationArgs(config: AnyRecord, options: AnyRecord = {}): { hasWindowsBundle: boolean; args: string[]; devtoolsProjectPath: string; projectStrategy: string } {
  const explicitProjectPath = String((config && config.devtoolsProjectPath) || '').trim()
  const hasProjectMap = Boolean(String((config && config.devtoolsProjectMap) || '').trim())
  const devtoolsProjectPath = resolveDevtoolsProjectPath(config, options)
  const env = resolveEnvironment(config, options)
  // 由 env 推导 windows 包标志，与 runtime 单源一致（WSL 恒为 win32 桥接），
  // 不再依赖 cliPath 是否 .bat 的脆弱判断。
  const hasWindowsBundle = usesWindowsDevtoolsBundle(env)
  let projectStrategy = 'direct'
  if (explicitProjectPath) {
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

function buildDevtoolsOpenArgs(config: AnyRecord, options: AnyRecord = {}): { args: string[]; devtoolsProjectPath: string; projectStrategy: string } {
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

/**
 * Windows DevTools 对盘符路径可可靠执行 open→auto；WSL UNC 的 open 会触发
 * code 17，因此只让可直接消费的 Windows 路径使用两阶段冷启动。
 */
function shouldOpenProjectBeforeAutomation(config: AnyRecord, options: AnyRecord = {}): boolean {
  const { hasWindowsBundle, devtoolsProjectPath } = buildAutomationArgs(config, options)
  return hasWindowsBundle && Boolean(devtoolsProjectPath) && !isWslUncPath(devtoolsProjectPath)
}

// ---- CLI 验证与运行 ----

function normalizeCliPath(rawPath: string, options: AnyRecord = {}): string {
  const trimmed = String(rawPath || '').trim()
  if (!trimmed) {
    return ''
  }

  const statInfo = existsSync(trimmed) ? statSync(trimmed) : null
  // 当前 Windows 安装包以 cli.bat 为公开入口；旧安装包才需要
  // cli.js + node.exe。两者并存时优先走官方批处理入口。
  if (statInfo && statInfo.isDirectory()) {
    const candidates = options.hasWindowsBundle
      ? [path.join(trimmed, 'cli.bat'), path.join(trimmed, 'cli.js')]
      : [path.join(trimmed, 'cli.js')]
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate
      }
    }
    return trimmed
  }

  return trimmed
}

function validateAutomationCliConfig(config: AnyRecord, options: AnyRecord = {}): void {
  const rawPath = String((config && config.cliPath) || '').trim()
  if (!rawPath) {
    const error = new Error('Missing WeChat DevTools CLI path. Set WECHAT_DEVTOOLS_CLI or pass --cli-path <path>.') as ErrorWithMeta
    error.code = 'DEVTOOLS_CLI_ERROR'
    throw error
  }

  const hasWindowsBundle = usesWindowsDevtoolsBundle(resolveEnvironment(config, options))
  const normalizedPath = normalizeCliPath(rawPath, { hasWindowsBundle })
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

  if (hasWindowsBundle) {
    if (/\.bat$/iu.test(cliPath)) {
      return
    }

    if (!/\.js$/iu.test(cliPath)) {
      throw new Error(`Unsupported Windows DevTools CLI entry: ${cliPath}. Expected cli.bat, or legacy cli.js with node.exe next to it.`)
    }

    const cliDirectory = path.dirname(cliPath)
    const nodeExePath = path.join(cliDirectory, 'node.exe')
    if (!existsSync(nodeExePath)) {
      throw new Error(`Legacy WeChat DevTools CLI bundle is incomplete near ${cliPath}; expected node.exe next to cli.js.`)
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

function runDevtoolsCli(config: AnyRecord, args: string[], options: AnyRecord = {}): AnyRecord {
  validateAutomationCliConfig(config, options)
  const cliDirectory = path.dirname(String(config.cliPath || ''))
  const hasWindowsBundle = usesWindowsDevtoolsBundle(resolveEnvironment(config, options))
  const timeoutMs = Number(options.timeoutMs || 30000)
  const converter = options.toWindowsPath || toWindowsPath
  const runner = (options.spawnSync || spawnSync) as typeof spawnSync
  const cliPath = String(config.cliPath || '')
  const windowsCliArg = hasWindowsBundle ? converter(cliPath) : cliPath

  let result
  if (hasWindowsBundle && /\.bat$/iu.test(cliPath)) {
    // Node 官方约束：Windows 不能把 .bat 当作独立可执行文件，需由 cmd.exe 启动。
    // https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows
    result = runner('cmd.exe', ['/d', '/c', windowsCliArg, ...args], {
      cwd: cliDirectory,
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
    })
  } else if (hasWindowsBundle) {
    result = runner(path.join(cliDirectory, 'node.exe'), [windowsCliArg, ...args], {
      cwd: cliDirectory,
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
    })
  } else {
    result = runner(cliPath, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
    })
  }

  return {
    ...result,
    raw: `${result.stdout || ''}${result.stderr || ''}`.trim(),
  }
}

function runAutomationCli(config: AnyRecord, options: AnyRecord = {}): AnyRecord {
  const { args } = buildAutomationArgs(config, options)
  return runDevtoolsCli(config, args, options)
}

function openDevtoolsProject(config: AnyRecord, options: AnyRecord = {}): AnyRecord {
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

function resolveDevtoolsProjectPathForClose(config: AnyRecord, options: AnyRecord = {}): string {
  const explicitPath = String((config && config.devtoolsProjectPath) || '').trim()
  if (explicitPath) {
    return explicitPath
  }

  const projectPath = String((config && config.projectPath) || '').trim()
  if (!projectPath) {
    return ''
  }

  const hasWindowsBundle = usesWindowsDevtoolsBundle(resolveEnvironment(config, options))
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

function closeDevtoolsProject(config: AnyRecord, options: AnyRecord = {}): AnyRecord {
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
    const err = error as ErrorWithMeta
    return {
      attempted: true,
      ok: false,
      projectPath,
      error: err && err.message ? String(err.message) : String(err),
    }
  }
}

function enableAutomation(config: AnyRecord, options: AnyRecord = {}): AnyRecord {
  // Windows 可消费的本地路径由连接层自动选择 open→auto，规避部分 DevTools
  // 冷启动时直接 auto 触发 cli server/plugin 未就绪。WSL UNC 仍跳过 open，
  // 因为该路径会触发 code 17（QR_PATH_NOT_VALID_OR_NOT_EXIST）。
  let preOpen = null
  if (options.openFirst) {
    preOpen = openDevtoolsProject(config, options)
    if (preOpen && !preOpen.ok) {
      const error = new Error(String(preOpen.error || 'Failed to open WeChat DevTools project before automation startup')) as ErrorWithMeta
      error.code = preOpen.code || 'DEVTOOLS_CLI_ERROR'
      error.hint = preOpen.hint
      error.raw = preOpen.raw
      throw error
    }
  }

  // 部分 Windows DevTools 版本在 open 成功后继续给 auto 传 --port，会输出
  // “✔ auto”但不真正监听 automation 端口。open 已完成实例定位，auto 让官方
  // CLI自行连接该实例；解析出的 DevTools port 仍保留在 config 供观测与 cleanup。
  const automationConfig = preOpen ? { ...config, devtoolsPort: '' } : config
  const result = runAutomationCli(automationConfig, options)
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
  resolveDevtoolsProjectPath,
  buildAutomationArgs,
  buildDevtoolsOpenArgs,
  shouldOpenProjectBeforeAutomation,
  validateAutomationCliConfig,
  runDevtoolsCli,
  runAutomationCli,
  openDevtoolsProject,
  resolveDevtoolsProjectPathForClose,
  closeDevtoolsProject,
  enableAutomation,
}
