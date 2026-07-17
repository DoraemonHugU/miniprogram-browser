const { readFileSync } = require('node:fs')

type AnyRecord = Record<string, any>

/**
 * CLI 进程运行的操作系统。裸 Linux 无 DevTools（DevTools 只装 win/mac），
 * 但 WSL 下 runtime 仍是 linux，需要桥接到 Windows DevTools。
 */
type RuntimeOS = 'win32' | 'darwin' | 'linux'

/**
 * DevTools 安装的操作系统。DevTools 本体只运行在 win32 / darwin。
 * WSL 场景里 runtime=linux 但 devtoolsHost=win32，需要做路径翻译与镜像桥接。
 */
type DevtoolsHostOS = 'win32' | 'darwin'

interface Environment {
  runtime: RuntimeOS
  devtoolsHost: DevtoolsHostOS
  /** runtime=linux 且 /proc/version 含 microsoft */
  isWsl: boolean
  /** runtime=linux 且 devtoolsHost=win32，需要路径桥接/镜像 */
  needsBridge: boolean
}

function detectRuntimeOS(): RuntimeOS {
  return process.platform as RuntimeOS
}

function readProcVersion(): string {
  try {
    return readFileSync('/proc/version', 'utf8')
  } catch (_) {
    return ''
  }
}

/**
 * WSL 判据：宿主必须是 linux，且 /proc/version 含 microsoft。
 * 比「能跑 wslpath」更稳——精简 WSL 镜像可能缺 wslpath，但 /proc/version 一定在。
 * versionText 可注入，便于单测不依赖真实文件系统。
 */
function detectWsl(versionText?: string): boolean {
  if (detectRuntimeOS() !== 'linux') {
    return false
  }
  const text = versionText !== undefined ? versionText : readProcVersion()
  return /microsoft/i.test(text)
}

/** DevTools Host 靠 cliPath 是否 .bat 推断：.bat 结尾表示装在 Windows。 */
function detectDevtoolsHost(config: AnyRecord): DevtoolsHostOS {
  return String((config && config.cliPath) || '').toLowerCase().endsWith('.bat') ? 'win32' : 'darwin'
}

function resolveEnvironment(config: AnyRecord, options: AnyRecord = {}): Environment {
  const runtime = detectRuntimeOS()
  const devtoolsHost = detectDevtoolsHost(config)
  const isWsl = detectWsl(options.readProcVersion)
  return {
    runtime,
    devtoolsHost,
    isWsl,
    needsBridge: runtime === 'linux' && devtoolsHost === 'win32',
  }
}

module.exports = {
  detectRuntimeOS,
  detectWsl,
  detectDevtoolsHost,
  resolveEnvironment,
}
