const fs = require('node:fs/promises')
const path = require('node:path')

type AnyRecord = Record<string, unknown>

const DEFAULT_INSPECT_SECTIONS = [
  'pagesSummary',
  'tabBarSummary',
  'state',
  'recentRoutes',
  'currentOutgoingEdges',
  'staticSummary',
]

const ALL_INSPECT_SECTIONS = [
  ...DEFAULT_INSPECT_SECTIONS,
  'pages',
  'tabbar',
  'observedEdges',
  'staticEdges',
  'routeConstants',
]

function normalizeRoutePath(value: unknown): string | null {
  const input = String(value || '').trim()
  if (!input) {
    return null
  }

  const withoutQuery = input.split('?')[0].trim()
  const normalized = withoutQuery.replace(/^\//u, '')
  return normalized || null
}

function normalizeInspectSections(options: AnyRecord = {}): string[] {
  if (options.all) {
    return [...ALL_INSPECT_SECTIONS]
  }

  const sections = String(options.sections || '').trim()
  if (!sections) {
    return [...DEFAULT_INSPECT_SECTIONS]
  }

  return sections
    .split(',')
    .map((item: string) => item.trim())
    .filter(Boolean)
}

function parseRouteConstantsFromSource(source: unknown): Record<string, string> {
  const input = String(source || '')
  const result: Record<string, string> = {}
  const objectRegex = /export\s+const\s+(\w+)\s*=\s*\{([\s\S]*?)\}/gu
  let objectMatch: RegExpExecArray | null

  while ((objectMatch = objectRegex.exec(input)) !== null) {
    const [, objectName, body] = objectMatch
    const entryRegex = /(\w+)\s*:\s*['"]([^'"]+)['"]/gu
    let entryMatch: RegExpExecArray | null
    while ((entryMatch = entryRegex.exec(body)) !== null) {
      const [, key, value] = entryMatch
      if (!/^\/?pages\//u.test(value.trim())) {
        continue
      }
      const route = normalizeRoutePath(value)
      if (route) {
        result[`${objectName}.${key}`] = route
      }
    }
  }

  return result
}

function resolveRouteFromFile(filePath: string, srcRoot: string): string | null {
  const relative = path.relative(srcRoot, filePath).replace(/\\/gu, '/')
  const match = relative.match(/^pages\/(.+)\/(index|main)\.[^.]+$/u)
  if (!match) {
    return null
  }

  return `pages/${match[1]}/index`
}

function resolveFileLabel(filePath: string, srcRoot: string): string {
  return path.relative(srcRoot, filePath).replace(/\\/gu, '/')
}

interface StaticEdge {
  from: string | null
  to: string | null
  method: string
  source: string | null
  file: string
}

function parseStaticEdgesFromSource({
  source,
  filePath,
  srcRoot,
  routeConstants = {},
}: {
  source: unknown
  filePath: string
  srcRoot: string
  routeConstants: Record<string, string>
}): StaticEdge[] {
  const input = String(source || '')
  const from = resolveRouteFromFile(filePath, srcRoot)
  const file = resolveFileLabel(filePath, srcRoot)
  const edges: StaticEdge[] = []
  const routeMethods = ['navigateTo', 'reLaunch', 'redirectTo', 'switchTab']

  for (const method of routeMethods) {
    const regex = new RegExp(`${method}\\s*\\(\\s*\\{[\\s\\S]*?url\\s*:\\s*([^,}]+)`, 'gu')
    let match: RegExpExecArray | null
    while ((match = regex.exec(input)) !== null) {
      const rawValue = match[1].trim()
      let to: string | null = null
      let sourceValue: string | null = null

      const stringMatch = rawValue.match(/^['"]([^'"]+)['"]/u)
      if (stringMatch) {
        sourceValue = stringMatch[1]
        to = normalizeRoutePath(sourceValue)
      } else {
        const constantMatch = rawValue.match(/^[A-Z_][\w]*\.\w+/u)
        if (constantMatch) {
          sourceValue = constantMatch[0]
          to = routeConstants[sourceValue] || null
        }
      }

      edges.push({
        from,
        to,
        method,
        source: sourceValue,
        file,
      })
    }
  }

  const backRegex = /navigateBack\s*\(/gu
  while (backRegex.exec(input) !== null) {
    edges.push({
      from,
      to: null,
      method: 'navigateBack',
      source: null,
      file,
    })
  }

  const navigatorRegex = /<navigator\b[^>]*\burl\s*=\s*['"]([^'"]+)['"][^>]*>/giu
  let navigatorMatch: RegExpExecArray | null
  while ((navigatorMatch = navigatorRegex.exec(input)) !== null) {
    edges.push({
      from,
      to: normalizeRoutePath(navigatorMatch[1]),
      method: 'navigateTo',
      source: navigatorMatch[1],
      file,
    })
  }

  return edges
}

function buildStaticSummary(staticEdges: StaticEdge[] = [], routeConstants: Record<string, string> = {}): Record<string, unknown> {
  const methods = new Set((staticEdges || []).map((item) => item.method))
  return {
    staticEdgeCount: (staticEdges || []).length,
    hasNavigateTo: methods.has('navigateTo'),
    hasReLaunch: methods.has('reLaunch'),
    hasSwitchTab: methods.has('switchTab'),
    hasNavigateBack: methods.has('navigateBack'),
    routeConstantsCount: Object.keys(routeConstants || {}).length,
  }
}

function buildPagesSummary(runtimeConfig: AnyRecord = {}): Record<string, unknown> {
  const pages = Array.isArray(runtimeConfig.pages) ? runtimeConfig.pages : []
  return {
    count: pages.length,
    entryPagePath: runtimeConfig.entryPagePath || (pages[0] as string | undefined) || null,
  }
}

function buildTabBarSummary(tabBar: AnyRecord = {}): Record<string, unknown> {
  const list = Array.isArray(tabBar.list) ? tabBar.list : []
  return {
    count: list.length,
    pages: list
      .map((item: AnyRecord) => normalizeRoutePath(item.pagePath || item.path || ''))
      .filter(Boolean),
  }
}

function summarizeRecentRoutes(routeEvents: { message?: string }[] = [], limit = 5): string[] {
  return (routeEvents || [])
    .slice(-limit)
    .map((item) => String(item && item.message ? item.message : '').trim())
    .filter(Boolean)
}

function buildCurrentOutgoingEdges(current: unknown, staticEdges: StaticEdge[] = [], observedEdges: StaticEdge[] = []): Record<string, unknown>[] {
  const currentPath = normalizeRoutePath(current)
  if (!currentPath) {
    return []
  }

  const observedSet = new Set((observedEdges || []).map((item) => `${item.from}|${item.to}|${item.method}`))
  const grouped = new Map<string, Record<string, unknown>>()

  for (const edge of staticEdges || []) {
    if (normalizeRoutePath(edge.from) !== currentPath || !edge.to) {
      continue
    }
    const key = normalizeRoutePath(edge.to)
    if (!key) {
      continue
    }

    const entry = grouped.get(key) || {
      to: key,
      methods: [] as string[],
      observed: false,
    }
    if (!(entry.methods as string[]).includes(edge.method)) {
      (entry.methods as string[]).push(edge.method)
    }
    if (observedSet.has(`${currentPath}|${key}|${edge.method}`)) {
      entry.observed = true
    }
    grouped.set(key, entry)
  }

  return [...grouped.values()]
}

function dedupeStaticEdges(staticEdges: StaticEdge[] = []): StaticEdge[] {
  const seen = new Set<string>()
  const deduped: StaticEdge[] = []

  for (const edge of staticEdges) {
    const key = [edge.from || '', edge.to || '', edge.method || '', edge.source || ''].join('|')
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    deduped.push(edge)
  }

  return deduped
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath)
    return true
  } catch (_) {
    return false
  }
}

async function collectFiles(rootDir: string, extensions: Set<string>, files: string[] = []): Promise<string[]> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name)
    if (entry.isDirectory()) {
      await collectFiles(fullPath, extensions, files)
      continue
    }

    if (extensions.has(path.extname(entry.name))) {
      files.push(fullPath)
    }
  }
  return files
}

async function resolveStaticRoots(projectPath: string): Promise<{ sourceRoot: string | null; scanRoots: string[] }> {
  const scanRoots: string[] = []

  const projectConfigPath = path.join(projectPath, 'project.config.json')
  if (await pathExists(projectConfigPath)) {
    const projectConfig = JSON.parse(await fs.readFile(projectConfigPath, 'utf8'))
    const miniprogramRoot = path.resolve(projectPath, String(projectConfig.miniprogramRoot || '').trim())
    if (await pathExists(miniprogramRoot)) {
      scanRoots.push(miniprogramRoot)
    }
  }

  const sourceRoot = path.join(projectPath, 'src')
  if (await pathExists(sourceRoot) && !scanRoots.includes(sourceRoot)) {
    scanRoots.push(sourceRoot)
  }

  return {
    sourceRoot: scanRoots[0] || null,
    scanRoots,
  }
}

async function inspectStaticProject(projectPath: string): Promise<Record<string, unknown>> {
  const { sourceRoot, scanRoots } = await resolveStaticRoots(projectPath)
  if (!sourceRoot || scanRoots.length === 0) {
    return {
      appConfig: {},
      routeConstants: {},
      staticEdges: [],
      staticSummary: buildStaticSummary([], {}),
      sourceRoot: null,
      scanRoots: [],
    }
  }

  let appConfig: AnyRecord = {}
  const appJsonPath = path.join(sourceRoot, 'app.json')
  if (await pathExists(appJsonPath)) {
    try {
      appConfig = JSON.parse(await fs.readFile(appJsonPath, 'utf8'))
    } catch (_) {
      appConfig = {}
    }
  }

  const codeFiles: { filePath: string; rootDir: string }[] = []
  const seenFiles = new Set<string>()
  for (const rootDir of scanRoots) {
    const files = await collectFiles(rootDir, new Set(['.ts', '.tsx', '.js', '.jsx', '.json', '.wxml', '.vue']))
    for (const filePath of files) {
      if (seenFiles.has(filePath)) {
        continue
      }
      seenFiles.add(filePath)
      codeFiles.push({ filePath, rootDir })
    }
  }

  const routeConstants: Record<string, string> = {}
  for (const item of codeFiles) {
    const filePath = item.filePath
    const content = await fs.readFile(filePath, 'utf8')
    Object.assign(routeConstants, parseRouteConstantsFromSource(content))
  }

  const staticEdges: StaticEdge[] = []
  for (const item of codeFiles) {
    const filePath = item.filePath
    const content = await fs.readFile(filePath, 'utf8')
    staticEdges.push(...parseStaticEdgesFromSource({
      source: content,
      filePath,
      srcRoot: item.rootDir,
      routeConstants,
    }))
  }

  const dedupedStaticEdges = dedupeStaticEdges(staticEdges)

  return {
    appConfig,
    routeConstants,
    staticEdges: dedupedStaticEdges,
    staticSummary: buildStaticSummary(dedupedStaticEdges, routeConstants),
    sourceRoot,
    scanRoots,
  }
}

async function inspectProjectStructure({
  projectPath,
  runtimeConfig,
  current,
  pageStack,
  recentRoutes,
  observedEdges,
  sections,
}: {
  projectPath: string
  runtimeConfig?: AnyRecord
  current?: string
  pageStack?: { path: string }[]
  recentRoutes?: { message?: string }[]
  observedEdges?: StaticEdge[]
  sections?: string[]
}): Promise<Record<string, unknown>> {
  const normalizedSections = sections || normalizeInspectSections({})
  const staticInspection = await inspectStaticProject(projectPath)
  const effectiveRuntimeConfig = runtimeConfig && Object.keys(runtimeConfig).length
    ? runtimeConfig
    : (staticInspection.appConfig as AnyRecord)
  const effectivePageStack = Array.isArray(pageStack) ? pageStack : []
  const stackCurrent = effectivePageStack.length
    ? effectivePageStack[effectivePageStack.length - 1].path
    : ''
  const effectiveCurrent = current || stackCurrent || null
  const result: AnyRecord = {
    sections: normalizedSections,
  }

  if (normalizedSections.includes('pages')) {
    result.pages = Array.isArray(effectiveRuntimeConfig && effectiveRuntimeConfig.pages) ? effectiveRuntimeConfig.pages : []
  }
  if (normalizedSections.includes('pagesSummary')) {
    result.pagesSummary = buildPagesSummary(effectiveRuntimeConfig)
  }
  if (normalizedSections.includes('tabbar')) {
    result.tabBar = effectiveRuntimeConfig && effectiveRuntimeConfig.tabBar ? effectiveRuntimeConfig.tabBar : { list: [] }
  }
  if (normalizedSections.includes('tabBarSummary')) {
    result.tabBarSummary = buildTabBarSummary((effectiveRuntimeConfig && effectiveRuntimeConfig.tabBar ? effectiveRuntimeConfig.tabBar : { list: [] }) as AnyRecord)
  }
  if (normalizedSections.includes('state')) {
    result.current = effectiveCurrent
    result.pageStack = effectivePageStack
  }
  if (normalizedSections.includes('recentRoutes')) {
    result.recentRoutes = summarizeRecentRoutes(recentRoutes)
  }
  if (normalizedSections.includes('observedEdges')) {
    result.observedEdges = Array.isArray(observedEdges) ? observedEdges : []
  }
  if (normalizedSections.includes('currentOutgoingEdges')) {
    result.currentOutgoingEdges = buildCurrentOutgoingEdges(effectiveCurrent, staticInspection.staticEdges as StaticEdge[], observedEdges)
  }
  if (normalizedSections.includes('staticSummary')) {
    result.staticSummary = staticInspection.staticSummary
  }
  if (normalizedSections.includes('staticEdges')) {
    result.staticEdges = staticInspection.staticEdges
  }
  if (normalizedSections.includes('routeConstants')) {
    result.routeConstants = staticInspection.routeConstants
  }

  return result
}

function formatInspectLines(payload: AnyRecord = {}): string[] {
  const lines: string[] = []

  if (payload.pagesSummary) {
    const ps = payload.pagesSummary as Record<string, unknown>
    lines.push(`pages=${ps.count}${ps.entryPagePath ? ` entry=${ps.entryPagePath}` : ''}`)
  }
  if (payload.tabBarSummary) {
    const ts = payload.tabBarSummary as Record<string, unknown>
    lines.push(`tabBar=${ts.count}`)
  }
  if ('current' in payload) {
    lines.push(`current=${payload.current || '(none)'}`)
  }
  if (Array.isArray(payload.pageStack)) {
    lines.push(`pageStack=${payload.pageStack.map((item: AnyRecord) => item.path).join(' -> ') || '(empty)'}`)
  }
  if (Array.isArray(payload.recentRoutes)) {
    lines.push(`recentRoutes=${payload.recentRoutes.length}`)
  }
  if (Array.isArray(payload.currentOutgoingEdges)) {
    lines.push(`currentOutgoing=${payload.currentOutgoingEdges.length}`)
    for (const edge of payload.currentOutgoingEdges) {
      lines.push(`  ${(edge.methods as string[]).join('|')} -> ${edge.to}${edge.observed ? ' [observed]' : ''}`)
    }
  }
  if (payload.staticSummary) {
    const ss = payload.staticSummary as Record<string, unknown>
    lines.push(`staticEdges=${ss.staticEdgeCount}`)
    lines.push(`staticMethods=navigateTo:${ss.hasNavigateTo ? 'yes' : 'no'} reLaunch:${ss.hasReLaunch ? 'yes' : 'no'} switchTab:${ss.hasSwitchTab ? 'yes' : 'no'} navigateBack:${ss.hasNavigateBack ? 'yes' : 'no'}`)
  }

  return lines
}

module.exports = {
  normalizeRoutePath,
  normalizeInspectSections,
  parseRouteConstantsFromSource,
  parseStaticEdgesFromSource,
  buildStaticSummary,
  buildCurrentOutgoingEdges,
  dedupeStaticEdges,
  resolveStaticRoots,
  inspectProjectStructure,
  formatInspectLines,
}
