/**
 * runtime-windows.ts — Windows 路径转换工具
 *
 * 仅保留被其他模块使用的纯路径/命令行工具函数。
 * managed-mirror（rsync 复制到宿主机 temp）已删除；WSL UNC 路径直传 devtools auto。
 */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process'

function toWindowsPath(inputPath: string): string {
  const normalizedInput = String(inputPath || '').trim()
  if (!normalizedInput.startsWith('/')) {
    return normalizedInput
  }

  const mountedDriveMatch = normalizedInput.match(/^\/mnt\/([a-z])(?:\/(.*))?$/iu)
  if (mountedDriveMatch) {
    const [, driveLetter, rest = ''] = mountedDriveMatch
    const windowsRest = rest ? rest.replace(/\//gu, '\\') : ''
    return `${driveLetter.toUpperCase()}:\\${windowsRest}`
  }

  const result: SpawnSyncReturns<string> = spawnSync('wslpath', ['-w', normalizedInput], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`Failed to convert path with wslpath: ${normalizedInput}`)
  }

  return result.stdout.trim()
}

function isWslUncPath(inputPath: string): boolean {
  const normalized = String(inputPath || '').trim().replace(/\//gu, '\\')
  return /^\\\\(?:wsl\.localhost|wsl\$)\\/iu.test(normalized)
}

function runWindowsCommand(script: string): SpawnSyncReturns<string> {
  // cmd.exe 从 Windows 本地路径启动，避免 WSL 的 UNC 当前目录问题。
  return spawnSync('cmd.exe', ['/C', script], {
    cwd: '/mnt/c',
    encoding: 'utf8',
  })
}

function normalizeWindowsPathForCompare(inputPath: string): string {
  return String(inputPath || '').trim().replace(/\//gu, '\\').replace(/\\+$/u, '').toLowerCase()
}

module.exports = {
  toWindowsPath,
  isWslUncPath,
  runWindowsCommand,
  normalizeWindowsPathForCompare,
}
