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
 *
 * devtoolsHost 由 runtime 推导（非 cliPath 扩展名）：linux 恒为 win32（WSL 桥接），
 * win32/darwin 与 runtime 同值。这比「cliPath 是否 .bat」更稳——Windows 上
 * 即便用 .exe 包裹（非 .bat 入口）也不会被误判成 mac。
 */
type DevtoolsHostOS = 'win32' | 'darwin'

interface Environment {
  runtime: RuntimeOS
  devtoolsHost: DevtoolsHostOS
  /** runtime=linux 且存在 WSL 信号（/proc/version 含 microsoft 或 WSL_DISTRO_NAME） */
  isWsl: boolean
  /** runtime=linux 且 devtoolsHost=win32，需要路径桥接/镜像 */
  needsBridge: boolean
}

/** platform 可注入，便于单测覆盖 win32/darwin/linux 三态。缺省取真实 process.platform。 */
function detectRuntimeOS(platform?: string): RuntimeOS {
  return (platform || process.platform) as RuntimeOS
}

function readProcVersion(): string {
  try {
    return readFileSync('/proc/version', 'utf8')
  } catch (_) {
    return ''
  }
}

/**
 * WSL 判据：宿主必须是 linux，且满足以下任一信号：
 *  - /proc/version 含 microsoft（主信号，WSL1/2 精简镜像都在，比 wslpath 稳）
 *  - 存在 WSL_DISTRO_NAME（WSL 始终注入，裸 linux 不会设置；辅助信号）
 * versionText / wslDistroName / runtime 均可注入，便于单测不依赖真实文件系统或环境。
 */
function detectWsl(versionText?: string, options: AnyRecord = {}): boolean {
  if (detectRuntimeOS(options.runtime) !== 'linux') {
    return false
  }
  const text = versionText !== undefined ? versionText : readProcVersion()
  if (/microsoft/i.test(text)) {
    return true
  }
  const distroName =
    options.wslDistroName !== undefined ? options.wslDistroName : process.env.WSL_DISTRO_NAME
  return Boolean(distroName && String(distroName).trim())
}

/** devtoolsHost 由 runtime 推导：linux 恒桥接 Windows，其余与 runtime 同值。 */
function detectDevtoolsHost(runtime: RuntimeOS): DevtoolsHostOS {
  return runtime === 'linux' ? 'win32' : (runtime as DevtoolsHostOS)
}

function resolveEnvironment(config: AnyRecord, options: AnyRecord = {}): Environment {
  const runtime = detectRuntimeOS(options.runtime)
  const isWsl = detectWsl(options.readProcVersion, {
    runtime,
    wslDistroName: options.wslDistroName,
  })
  const devtoolsHost = detectDevtoolsHost(runtime)
  return {
    runtime,
    devtoolsHost,
    isWsl,
    // 桥接（路径翻译 + 受控镜像）只发生在 WSL：裸 linux 无 DevTools 可达，无需桥接。
    needsBridge: isWsl,
  }
}

module.exports = {
  detectRuntimeOS,
  detectWsl,
  detectDevtoolsHost,
  resolveEnvironment,
}
