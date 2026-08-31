/**
 * runtime-windows.ts — Windows 路径转换工具
 *
 * 仅保留被其他模块使用的纯路径/命令行工具函数。
 * managed-mirror（rsync 复制到宿主机 temp）已删除；WSL UNC 路径直传 devtools auto。
 */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process'

type SpawnSyncFn = typeof spawnSync

function toWindowsPath(inputPath: string, options: { spawnSync?: SpawnSyncFn } = {}): string {
  const normalizedInput = String(inputPath || '').trim()
  if (!normalizedInput.startsWith('/')) {
    return normalizedInput
  }

  // WSL 的 automount root 可配置，不能假设盘符路径永远位于 /mnt。
  // 统一使用系统自带 wslpath 作为路径翻译的权威实现：
  // https://learn.microsoft.com/en-us/windows/dev-environment/wsl-interop#path-translation
  const runner = options.spawnSync || spawnSync
  const result = runner('wslpath', ['-w', normalizedInput], { encoding: 'utf8' }) as SpawnSyncReturns<string>
  const converted = String(result.stdout || '').trim()
  if (result.status !== 0 || !converted) {
    const detail = String(result.stderr || result.error?.message || `exit status ${result.status}`).trim()
    throw new Error(`Failed to convert path with wslpath: ${normalizedInput}${detail ? ` (${detail})` : ''}`)
  }

  return converted
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
