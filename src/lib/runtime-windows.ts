const { existsSync } = require('node:fs')
const { createHash } = require('node:crypto')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

type AnyRecord = Record<string, any>

const MANAGED_PROJECT_MARKER = '.miniprogram-browser-managed'

function toWindowsPath(inputPath) {
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

  const result = spawnSync('wslpath', ['-w', normalizedInput], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`Failed to convert path with wslpath: ${normalizedInput}`)
  }

  return result.stdout.trim()
}

function isWslUncPath(inputPath) {
  const normalized = String(inputPath || '').trim().replace(/\//gu, '\\')
  return /^\\\\(?:wsl\.localhost|wsl\$)\\/iu.test(normalized)
}

function runWindowsCommand(script) {
  // cmd.exe 在 WSL UNC 路径（/mnt/c/...）下启动时会丢失 UNC 参数解析能力。
  // pushd C:\ 确保 cmd.exe 在当前目录为 Windows 本地盘时执行脚本。
  return spawnSync('cmd.exe', ['/C', `pushd C:\\ && ${script}`], {
    encoding: 'utf8',
  })
}

function splitWslUncPath(inputPath) {
  const normalized = String(inputPath || '').trim().replace(/\//gu, '\\')
  const match = normalized.match(/^\\\\(wsl\.localhost|wsl\$)\\([^\\]+)(?:\\(.*))?$/iu)
  if (!match) {
    return null
  }

  const [, host, distroName, rest = ''] = match
  if (!/^[a-z0-9_.-]+$/iu.test(distroName)) {
    return null
  }

  return {
    target: `\\\\${host}\\${distroName}`,
    fullPath: normalized,
    rest,
  }
}

function isSafeWindowsShellPath(inputPath) {
  return /^[a-z]:\\[a-z0-9_.~\\-]+$/iu.test(String(inputPath || ''))
}

function isSafeWslUncShellPath(inputPath) {
  return /^\\\\(?:wsl\.localhost|wsl\$)\\[a-z0-9_.-]+(?:\\[a-z0-9_.-]+)*$/iu.test(String(inputPath || ''))
}

function isManagedWindowsProjectLinkPath(inputPath) {
  return /^[a-z]:\\[a-z0-9_.~\\-]+(?:\\[a-z0-9_.~\\-]+)*\\miniprogram-browser\\project-[a-f0-9]{12}(?:-[0-9]+)?$/iu.test(String(inputPath || ''))
}

function isManagedWindowsProjectPath(inputPath) {
  return isManagedWindowsProjectLinkPath(inputPath)
}

function normalizeWindowsPathForCompare(inputPath) {
  return String(inputPath || '').trim().replace(/\//gu, '\\').replace(/\\+$/u, '').toLowerCase()
}

function isAutoLinkTargetForProject(config, targetPath, options: AnyRecord = {}) {
  const projectPath = String((config && config.projectPath) || '').trim()
  if (!projectPath || !projectPath.startsWith('/')) {
    return false
  }

  const converter = options.toWindowsPath || toWindowsPath
  let expectedTarget = ''
  try {
    expectedTarget = converter(projectPath)
  } catch (_) {
    return false
  }

  return normalizeWindowsPathForCompare(expectedTarget) === normalizeWindowsPathForCompare(targetPath)
}

function windowsPathExists(inputPath, runCommand = runWindowsCommand) {
  if (!isSafeWindowsShellPath(inputPath)) {
    return false
  }
  const result = runCommand(`if exist ${inputPath} (exit /b 0) else (exit /b 1)`)
  return result && result.status === 0
}

function isWindowsDirectoryEmpty(inputPath, runCommand = runWindowsCommand) {
  if (!isSafeWindowsShellPath(inputPath)) {
    return false
  }

  const result = runCommand(`dir /A /B ${inputPath}`)
  if (!result || result.status !== 0) {
    return false
  }

  return String(result.stdout || '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .length === 0
}

function readWindowsPathAttributes(inputPath, runCommand = runWindowsCommand) {
  if (!isSafeWindowsShellPath(inputPath)) {
    return ''
  }

  const result = runCommand(`for %I in (${inputPath}) do @echo %~aI`)
  if (!result || result.status !== 0) {
    return ''
  }

  return String(result.stdout || '').split(/\r?\n/u).map((line) => line.trim()).find(Boolean) || ''
}

function isWindowsDirectoryLinkPath(inputPath, runCommand = runWindowsCommand) {
  const attributes = readWindowsPathAttributes(inputPath, runCommand).toLowerCase()
  return attributes.includes('d') && attributes.includes('l')
}

function resolveWindowsTempDirectory(runCommand = runWindowsCommand) {
  const result = runCommand('echo %TEMP%')
  if (!result || result.status !== 0) {
    return ''
  }

  const lines = String(result.stdout || '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
  return lines.reverse().find((line) => /^[a-z]:\\/iu.test(line)) || ''
}

function isRobocopySuccess(result) {
  if (!result) {
    return false
  }
  const status = Number(result.status)
  return Number.isInteger(status) && status >= 0 && status <= 7
}

function createWindowsProjectMirrorFromWslUnc(uncPath, options: AnyRecord = {}) {
  const parsed = splitWslUncPath(uncPath)
  if (!parsed || !isSafeWslUncShellPath(parsed.fullPath)) {
    return null
  }

  const runCommand = options.runWindowsCommand || runWindowsCommand
  const tempDirectory = String(options.windowsTempDir || resolveWindowsTempDirectory(runCommand)).trim().replace(/\\+$/u, '')
  if (!isSafeWindowsShellPath(tempDirectory)) {
    return null
  }

  // Keep the primary managed mirror path stable for the same project so
  // DevTools can reuse its per-project trust/approval state across runs.
  // Additional concurrent mirrors still fall back to numbered suffixes.
  const mirrorKey = parsed.fullPath
  const mirrorHash = createHash('sha1').update(mirrorKey).digest('hex').slice(0, 12)
  const mirrorRoot = `${tempDirectory}\\miniprogram-browser`

  if (!isSafeWindowsShellPath(mirrorRoot)) {
    return null
  }

  const mkdirRootResult = runCommand(`if not exist ${mirrorRoot} mkdir ${mirrorRoot}`)
  if (!mkdirRootResult || mkdirRootResult.status !== 0) {
    return null
  }

  const mirrorCandidates = Array.from({ length: 8 }, (_item, index) => {
    const suffix = index === 0 ? '' : `-${index}`
    return `${mirrorRoot}\\project-${mirrorHash}${suffix}`
  })

  for (const mirrorPath of mirrorCandidates) {
    const markerPath = `${mirrorPath}\\${MANAGED_PROJECT_MARKER}`
    if (!isSafeWindowsShellPath(mirrorPath)) {
      continue
    }

    const mirrorExists = windowsPathExists(mirrorPath, runCommand)
    const markerExists = windowsPathExists(markerPath, runCommand)
    if (mirrorExists && !markerExists) {
      if (!isWindowsDirectoryLinkPath(mirrorPath, runCommand)) {
        if (!isWindowsDirectoryEmpty(mirrorPath, runCommand)) {
          continue
        }
        const removeEmptyMirrorResult = runCommand(`if exist ${mirrorPath} rmdir /S /Q ${mirrorPath}`)
        if (!removeEmptyMirrorResult || removeEmptyMirrorResult.status !== 0) {
          continue
        }
      } else {
        const removeLinkResult = runCommand(`if exist ${mirrorPath} rmdir ${mirrorPath}`)
        if (!removeLinkResult || removeLinkResult.status !== 0) {
          continue
        }
      }
    }

    const mkdirMirrorResult = runCommand(`if not exist ${mirrorPath} mkdir ${mirrorPath}`)
    if (!mkdirMirrorResult || mkdirMirrorResult.status !== 0) {
      continue
    }

    const copyResult = runCommand(`robocopy ${parsed.fullPath} ${mirrorPath} /MIR /XD node_modules .git /XF .DS_Store`)
    if (!isRobocopySuccess(copyResult)) {
      continue
    }

    const markerResult = runCommand(`echo ${parsed.fullPath} > ${markerPath}`)
    if (!markerResult || markerResult.status !== 0) {
      continue
    }

    if (!windowsPathExists(`${mirrorPath}\\project.config.json`, runCommand)) {
      continue
    }

    return {
      projectPath: mirrorPath,
      mirror: {
        path: mirrorPath,
        target: parsed.fullPath,
        created: true,
        strategy: 'managed-mirror',
        excludes: ['node_modules', '.git'],
      },
    }
  }

  return null
}

function resolveWindowsManagedProjectPath(uncPath, config, options: AnyRecord = {}) {
  const createMirror = options.createWindowsProjectMirror || createWindowsProjectMirrorFromWslUnc
  const result = createMirror(uncPath, { ...options, linkKey: config && config.autoPort ? String(config.autoPort) : '' })
  if (!result) {
    return ''
  }

  const projectPath = typeof result === 'string' ? result : result.projectPath
  if (!projectPath) {
    return ''
  }

  if (config && typeof config === 'object') {
    config.devtoolsProjectPath = projectPath
    if (result.mirror) {
      config.devtoolsProjectMirror = result.mirror
    }
  }

  return projectPath
}

function cleanupWindowsProjectAutoLink(config, options: AnyRecord = {}) {
  const link = config && config.devtoolsProjectAutoLink
  if (!link || !link.created || !link.path) {
    return false
  }

  const linkPath = String(link.path).trim()
  const targetPath = String(link.target || '').trim()
  if (!isSafeWindowsShellPath(linkPath) || !isManagedWindowsProjectLinkPath(linkPath) || !isSafeWslUncShellPath(targetPath)) {
    return false
  }
  if (!isAutoLinkTargetForProject(config, targetPath, options)) {
    return false
  }

  const runCommand = options.runWindowsCommand || runWindowsCommand
  if (!isWindowsDirectoryLinkPath(linkPath, runCommand)) {
    return false
  }

  const result = runCommand(`if exist ${linkPath} rmdir ${linkPath}`)
  if (result && result.status === 0 && config && typeof config === 'object') {
    delete config.devtoolsProjectAutoLink
  }
  return Boolean(result && result.status === 0)
}

function cleanupWindowsProjectMirror(config, options: AnyRecord = {}) {
  const mirror = config && config.devtoolsProjectMirror
  if (!mirror || !mirror.created || !mirror.path) {
    return false
  }

  const mirrorPath = String(mirror.path).trim()
  const targetPath = String(mirror.target || '').trim()
  if (!isSafeWindowsShellPath(mirrorPath) || !isManagedWindowsProjectPath(mirrorPath) || !isSafeWslUncShellPath(targetPath)) {
    return false
  }
  if (!isAutoLinkTargetForProject(config, targetPath, options)) {
    return false
  }

  const runCommand = options.runWindowsCommand || runWindowsCommand
  const hasMarker = windowsPathExists(`${mirrorPath}\\${MANAGED_PROJECT_MARKER}`, runCommand)
  if (!hasMarker && !isWindowsDirectoryEmpty(mirrorPath, runCommand)) {
    return false
  }

  const result = runCommand(`if exist ${mirrorPath} rmdir /S /Q ${mirrorPath}`)
  if (result && result.status === 0 && config && typeof config === 'object') {
    delete config.devtoolsProjectMirror
  }
  return Boolean(result && result.status === 0)
}

function isWindowsProjectMirrorDrained(config, options: AnyRecord = {}) {
  const mirror = config && config.devtoolsProjectMirror
  if (!mirror || !mirror.created || !mirror.path) {
    return false
  }

  const mirrorPath = String(mirror.path).trim()
  const targetPath = String(mirror.target || '').trim()
  if (!isSafeWindowsShellPath(mirrorPath) || !isManagedWindowsProjectPath(mirrorPath) || !isSafeWslUncShellPath(targetPath)) {
    return false
  }
  if (!isAutoLinkTargetForProject(config, targetPath, options)) {
    return false
  }

  const runCommand = options.runWindowsCommand || runWindowsCommand
  if (!windowsPathExists(mirrorPath, runCommand)) {
    return true
  }

  const markerPath = `${mirrorPath}\\${MANAGED_PROJECT_MARKER}`
  const hasMarker = windowsPathExists(markerPath, runCommand)
  if (hasMarker) {
    return false
  }

  return isWindowsDirectoryEmpty(mirrorPath, runCommand)
}

function readWindowsTextFile(inputPath, runCommand = runWindowsCommand) {
  if (!isSafeWindowsShellPath(inputPath)) {
    return ''
  }

  const result = runCommand(`type ${inputPath}`)
  if (!result || result.status !== 0) {
    return ''
  }

  return String(result.stdout || '').split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).join('\n')
}

function findManagedWindowsProjectMirrors(config, options: AnyRecord = {}) {
  const projectPath = String((config && config.projectPath) || '').trim()
  if (!projectPath || !projectPath.startsWith('/')) {
    return []
  }

  const converter = options.toWindowsPath || toWindowsPath
  let expectedTarget = ''
  try {
    expectedTarget = converter(projectPath)
  } catch (_) {
    return []
  }
  if (!isSafeWslUncShellPath(expectedTarget)) {
    return []
  }

  const runCommand = options.runWindowsCommand || runWindowsCommand
  const tempDirectory = String(options.windowsTempDir || resolveWindowsTempDirectory(runCommand)).trim().replace(/\\+$/u, '')
  if (!isSafeWindowsShellPath(tempDirectory)) {
    return []
  }

  const mirrorRoot = `${tempDirectory}\\miniprogram-browser`
  if (!isSafeWindowsShellPath(mirrorRoot)) {
    return []
  }

  const result = runCommand(`dir /A:D /B ${mirrorRoot}\\project-*`)
  if (!result || result.status !== 0) {
    return []
  }

  const mirrors = []
  const names = String(result.stdout || '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)

  for (const name of names) {
    const mirrorPath = `${mirrorRoot}\\${name}`
    if (!isManagedWindowsProjectPath(mirrorPath)) {
      continue
    }
    const markerTarget = readWindowsTextFile(`${mirrorPath}\\${MANAGED_PROJECT_MARKER}`, runCommand)
    if (normalizeWindowsPathForCompare(markerTarget) !== normalizeWindowsPathForCompare(expectedTarget)) {
      continue
    }
    mirrors.push({
      path: mirrorPath,
      target: markerTarget,
      created: true,
      strategy: 'managed-mirror',
    })
  }

  return mirrors
}

module.exports = {
  toWindowsPath,
  isWslUncPath,
  runWindowsCommand,
  splitWslUncPath,
  isSafeWindowsShellPath,
  isSafeWslUncShellPath,
  isManagedWindowsProjectLinkPath,
  isManagedWindowsProjectPath,
  normalizeWindowsPathForCompare,
  isAutoLinkTargetForProject,
  windowsPathExists,
  isWindowsDirectoryEmpty,
  readWindowsPathAttributes,
  isWindowsDirectoryLinkPath,
  resolveWindowsTempDirectory,
  isRobocopySuccess,
  createWindowsProjectMirrorFromWslUnc,
  resolveWindowsManagedProjectPath,
  cleanupWindowsProjectAutoLink,
  cleanupWindowsProjectMirror,
  isWindowsProjectMirrorDrained,
  readWindowsTextFile,
  findManagedWindowsProjectMirrors,
  MANAGED_PROJECT_MARKER,
}
