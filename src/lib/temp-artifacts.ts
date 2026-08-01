const { open, mkdir } = require('node:fs/promises') as typeof import('node:fs/promises')
const { createHash } = require('node:crypto') as typeof import('node:crypto')
const os = require('node:os') as typeof import('node:os')
const path = require('node:path') as typeof import('node:path')

interface TempScreenshotOptions {
  directory?: string
  projectName?: unknown
  projectPath?: unknown
  sessionName?: unknown
  route?: unknown
  mode?: unknown
  extension?: unknown
}

function shortHash(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 4)
}

function compactToken(value: unknown, fallback: string, maxLength: number): string {
  const raw = String(value || '').trim()
  const token = raw
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .toLowerCase()
  if (!token) {
    return `${fallback}-${shortHash(raw || fallback)}`
  }
  return token.slice(0, maxLength).replace(/-+$/gu, '') || fallback
}

function projectToken(options: TempScreenshotOptions): string {
  const projectName = String(options.projectName || '').trim()
  if (projectName) {
    return compactToken(projectName, 'project', 12)
  }

  const projectPath = String(options.projectPath || '').trim()
  const basename = projectPath ? path.basename(projectPath) : ''
  return compactToken(basename, 'project', 12)
}

function routeToken(route: unknown): string {
  const normalized = String(route || '').trim().replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '')
  const parts = normalized.split('/').filter(Boolean)
  const tail = parts.slice(-2).join('-') || 'route'
  return `${compactToken(tail, 'route', 14)}-${shortHash(normalized || 'route')}`
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
    compactToken(options.sessionName, 'session', 10),
    routeToken(options.route),
    compactToken(options.mode, 'layout', 8),
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

module.exports = {
  compactToken,
  allocateTempScreenshotPath,
}
