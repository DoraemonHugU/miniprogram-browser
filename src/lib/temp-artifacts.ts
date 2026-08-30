const { open, mkdir, stat } = require('node:fs/promises') as typeof import('node:fs/promises')
const os = require('node:os') as typeof import('node:os')
const path = require('node:path') as typeof import('node:path')

interface TempScreenshotOptions {
  directory?: string
  projectName?: unknown
  projectPath?: unknown
  route?: unknown
  mode?: unknown
  extension?: unknown
}

type PathApi = Pick<typeof path, 'dirname' | 'resolve' | 'sep'>

interface ScreenshotOutputOptions extends TempScreenshotOptions {
  cwd?: unknown
  pathApi?: PathApi
}

function compactToken(value: unknown, fallback: string, maxLength: number): string {
  const raw = String(value || '').trim()
  const token = raw
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .toLowerCase()
  if (!token) {
    return fallback
  }
  return token.slice(0, maxLength).replace(/-+$/gu, '') || fallback
}

function projectToken(options: TempScreenshotOptions): string {
  const projectName = String(options.projectName || '').trim()
  if (projectName) {
    return compactToken(projectName, 'project', 20)
  }

  const projectPath = String(options.projectPath || '').trim()
  const basename = projectPath ? path.basename(projectPath) : ''
  return compactToken(basename, 'project', 20)
}

function routeToken(route: unknown): string {
  const normalized = String(route || '').trim().replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '')
  const parts = normalized.split('/').filter(Boolean)
  const tail = parts.at(-1) === 'index' && parts.length > 1
    ? parts.at(-2)
    : parts.slice(-2).join('-')
  return compactToken(tail, 'route', 24)
}

function extensionToken(extension: unknown): string {
  const extensionValue = String(extension || 'png').trim().replace(/^\.+/u, '').toLowerCase()
  return /^[a-z0-9]+$/u.test(extensionValue) ? extensionValue : 'png'
}

function isAlreadyExistsError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && String((error as { code?: unknown }).code || '') === 'EEXIST',
  )
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && String((error as { code?: unknown }).code || '') === 'ENOENT',
  )
}

/** 使用指定平台的 Node path 实现，将用户输入解析为绝对文件系统路径。 */
function resolveFilesystemPath(inputPath: unknown, cwd: unknown = process.cwd(), pathApi: PathApi = path): string {
  const value = String(inputPath || '').trim()
  if (!value) {
    throw new Error('截图输出路径不能为空。')
  }
  return pathApi.resolve(String(cwd || process.cwd()), value)
}

function hasTrailingPathSeparator(inputPath: string, pathApi: PathApi): boolean {
  return inputPath.endsWith(pathApi.sep)
    || (pathApi.sep === '\\' && inputPath.endsWith('/'))
}

/** 判断目标路径是否位于给定目录内（目录本身也算在内）。 */
function isPathInside(targetPath: unknown, directoryPath: unknown): boolean {
  const target = String(targetPath || '').trim()
  const directory = String(directoryPath || '').trim()
  if (!target || !directory) {
    return false
  }

  const relativePath = path.relative(path.resolve(directory), path.resolve(target))
  return relativePath === ''
    || (relativePath !== '..' && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath))
}

function buildScreenshotPathNotice(targetPath: unknown, projectPath: unknown): string {
  if (!isPathInside(targetPath, projectPath)) {
    return ''
  }
  return '注意：截图输出位于小程序项目目录内，微信开发者工具可能因文件变更重新编译并重置页面状态；建议省略路径或写到项目目录外。'
}

/**
 * 为没有显式输出路径的截图分配一个短、可读且不会覆盖旧文件的路径。
 * 通过 open(..., 'wx') 让多个并行 CLI 进程安全地竞争同一个基础名。
 */
async function allocateTempScreenshotPath(options: TempScreenshotOptions = {}): Promise<string> {
  const directory = String(options.directory || path.join(os.tmpdir(), 'miniprogram-browser'))
  await mkdir(directory, { recursive: true })

  const stem = [
    'mpb',
    projectToken(options),
    routeToken(options.route),
    compactToken(options.mode, 'page', 10),
  ].join('-')
  const extension = extensionToken(options.extension)

  for (let suffix = 0; suffix < 1000; suffix += 1) {
    const suffixText = suffix === 0 ? '' : `-${suffix}`
    const targetPath = path.join(directory, `${stem}${suffixText}.${extension}`)
    try {
      const handle = await open(targetPath, 'wx')
      await handle.close()
      return targetPath
    } catch (error: unknown) {
      if (isAlreadyExistsError(error)) {
        continue
      }
      throw error
    }
  }

  throw new Error(`无法为截图分配临时文件名：${stem}.${extension} 已达到避让上限。`)
}

/**
 * 解析 screenshot 的可选输出路径。
 *
 * - 未指定：在临时目录中分配文件名；
 * - 已有目录或尾部分隔符目录：在该目录中分配文件名；
 * - 其他：作为显式文件路径，并自动创建父目录。
 */
async function resolveScreenshotOutputPath(
  outputPath: unknown,
  options: ScreenshotOutputOptions = {},
): Promise<string> {
  const input = String(outputPath || '').trim()
  if (!input) {
    return allocateTempScreenshotPath(options)
  }

  const pathApi = options.pathApi || path
  const resolvedPath = resolveFilesystemPath(input, options.cwd, pathApi)
  let directoryIntent = hasTrailingPathSeparator(input, pathApi)
  try {
    directoryIntent = (await stat(resolvedPath)).isDirectory()
  } catch (error: unknown) {
    if (!isNotFoundError(error)) {
      throw error
    }
  }

  if (directoryIntent) {
    return allocateTempScreenshotPath({ ...options, directory: resolvedPath })
  }

  await mkdir(pathApi.dirname(resolvedPath), { recursive: true })
  return resolvedPath
}

module.exports = {
  compactToken,
  resolveFilesystemPath,
  resolveScreenshotOutputPath,
  isPathInside,
  buildScreenshotPathNotice,
  allocateTempScreenshotPath,
}
