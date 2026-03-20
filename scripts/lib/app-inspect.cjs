const fs = require('node:fs/promises')
const path = require('node:path')

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

function normalizeRoutePath(value) {
  const input = String(value || '').trim()
  if (!input) {
    return null
  }

  const withoutQuery = input.split('?')[0].trim()
  const normalized = withoutQuery.replace(/^\//u, '')
  return normalized || null
}

function normalizeInspectSections(options = {}) {
  if (options.all) {
    return [...ALL_INSPECT_SECTIONS]
  }

  const sections = String(options.sections || '').trim()
  if (!sections) {
    return [...DEFAULT_INSPECT_SECTIONS]
  }

  return sections
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function parseRouteConstantsFromSource(source) {
  const input = String(source || '')
  const result = {}
  const objectRegex = /export\s+const\s+(\w+)\s*=\s*\{([\s\S]*?)\}/gu
  let objectMatch

  while ((objectMatch = objectRegex.exec(input)) !== null) {
    const [, objectName, body] = objectMatch
    const entryRegex = /(\w+)\s*:\s*['"]([^'"]+)['"]/gu
    let entryMatch
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

function resolveRouteFromFile(filePath, srcRoot) {
  const relative = path.relative(srcRoot, filePath).replace(/\\/gu, '/')
  const match = relative.match(/^pages\/(.+)\/(index|main)\.[^.]+$/u)
  if (!match) {
    return null
  }

  return `pages/${match[1]}/index`
}

function resolveFileLabel(filePath, srcRoot) {
  return path.relative(srcRoot, filePath).replace(/\\/gu, '/')
}

function parseStaticEdgesFromSource({ source, filePath, srcRoot, routeConstants = {} }) {
  const input = String(source || '')
  const from = resolveRouteFromFile(filePath, srcRoot)
  const file = resolveFileLabel(filePath, srcRoot)
  const edges = []
  const routeMethods = ['navigateTo', 'reLaunch', 'redirectTo', 'switchTab']

  for (const method of routeMethods) {
    const regex = new RegExp(`${method}\\s*\\(\\s*\\{[\\s\\S]*?url\\s*:\\s*([^,}]+)`, 'gu')
    let match
    while ((match = regex.exec(input)) !== null) {
      const rawValue = match[1].trim()
      let to = null
      let sourceValue = null

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

  return edges
}

function buildStaticSummary(staticEdges, routeConstants) {
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

function buildPagesSummary(runtimeConfig = {}) {
  const pages = Array.isArray(runtimeConfig.pages) ? runtimeConfig.pages : []
  return {
    count: pages.length,
    entryPagePath: runtimeConfig.entryPagePath || pages[0] || null,
  }
}

function buildTabBarSummary(tabBar = {}) {
  const list = Array.isArray(tabBar.list) ? tabBar.list : []
  return {
    count: list.length,
    pages: list
      .map((item) => normalizeRoutePath(item.pagePath || item.path || ''))
      .filter(Boolean),
  }
}

function summarizeRecentRoutes(routeEvents, limit = 5) {
  return (routeEvents || [])
    .slice(-limit)
    .map((item) => String(item && item.message ? item.message : '').trim())
    .filter(Boolean)
}

function buildCurrentOutgoingEdges(current, staticEdges = [], observedEdges = []) {
  const currentPath = normalizeRoutePath(current)
  if (!currentPath) {
    return []
  }

  const observedSet = new Set((observedEdges || []).map((item) => `${item.from}|${item.to}|${item.method}`))
  const grouped = new Map()

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
      methods: [],
      observed: false,
    }
    if (!entry.methods.includes(edge.method)) {
      entry.methods.push(edge.method)
    }
    if (observedSet.has(`${currentPath}|${key}|${edge.method}`)) {
      entry.observed = true
    }
    grouped.set(key, entry)
  }

  return [...grouped.values()]
}

function dedupeStaticEdges(staticEdges = []) {
  const seen = new Set()
  const deduped = []

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

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath)
    return true
  } catch (_) {
    return false
  }
}

async function collectFiles(rootDir, extensions, files = []) {
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

async function resolveStaticRoots(projectPath) {
  const scanRoots = []

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

async function inspectStaticProject(projectPath) {
  const { sourceRoot, scanRoots } = await resolveStaticRoots(projectPath)
  if (!sourceRoot || scanRoots.length === 0) {
    return {
      routeConstants: {},
      staticEdges: [],
      staticSummary: buildStaticSummary([], {}),
      sourceRoot: null,
      scanRoots: [],
    }
  }

  const codeFiles = []
  const seenFiles = new Set()
  for (const rootDir of scanRoots) {
    const files = await collectFiles(rootDir, new Set(['.ts', '.tsx', '.js', '.jsx', '.json']))
    for (const filePath of files) {
      if (seenFiles.has(filePath)) {
        continue
      }
      seenFiles.add(filePath)
      codeFiles.push({ filePath, rootDir })
    }
  }

  const routeConstants = {}
  for (const item of codeFiles) {
    const filePath = item.filePath
    const content = await fs.readFile(filePath, 'utf8')
    Object.assign(routeConstants, parseRouteConstantsFromSource(content))
  }

  const staticEdges = []
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
}) {
  const normalizedSections = sections || normalizeInspectSections({})
  const staticInspection = await inspectStaticProject(projectPath)
  const result = {
    sections: normalizedSections,
  }

  if (normalizedSections.includes('pages')) {
    result.pages = Array.isArray(runtimeConfig && runtimeConfig.pages) ? runtimeConfig.pages : []
  }
  if (normalizedSections.includes('pagesSummary')) {
    result.pagesSummary = buildPagesSummary(runtimeConfig)
  }
  if (normalizedSections.includes('tabbar')) {
    result.tabBar = runtimeConfig && runtimeConfig.tabBar ? runtimeConfig.tabBar : { list: [] }
  }
  if (normalizedSections.includes('tabBarSummary')) {
    result.tabBarSummary = buildTabBarSummary(runtimeConfig && runtimeConfig.tabBar ? runtimeConfig.tabBar : { list: [] })
  }
  if (normalizedSections.includes('state')) {
    result.current = current || null
    result.pageStack = Array.isArray(pageStack) ? pageStack : []
  }
  if (normalizedSections.includes('recentRoutes')) {
    result.recentRoutes = summarizeRecentRoutes(recentRoutes)
  }
  if (normalizedSections.includes('observedEdges')) {
    result.observedEdges = Array.isArray(observedEdges) ? observedEdges : []
  }
  if (normalizedSections.includes('currentOutgoingEdges')) {
    result.currentOutgoingEdges = buildCurrentOutgoingEdges(current, staticInspection.staticEdges, observedEdges)
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

function formatInspectLines(payload) {
  const lines = []

  if (payload.pagesSummary) {
    lines.push(`pages=${payload.pagesSummary.count}${payload.pagesSummary.entryPagePath ? ` entry=${payload.pagesSummary.entryPagePath}` : ''}`)
  }
  if (payload.tabBarSummary) {
    lines.push(`tabBar=${payload.tabBarSummary.count}`)
  }
  if ('current' in payload) {
    lines.push(`current=${payload.current || '(none)'}`)
  }
  if (Array.isArray(payload.pageStack)) {
    lines.push(`pageStack=${payload.pageStack.map((item) => item.path).join(' -> ') || '(empty)'}`)
  }
  if (Array.isArray(payload.recentRoutes)) {
    lines.push(`recentRoutes=${payload.recentRoutes.length}`)
  }
  if (Array.isArray(payload.currentOutgoingEdges)) {
    lines.push(`currentOutgoing=${payload.currentOutgoingEdges.length}`)
    for (const edge of payload.currentOutgoingEdges) {
      lines.push(`  ${edge.methods.join('|')} -> ${edge.to}${edge.observed ? ' [observed]' : ''}`)
    }
  }
  if (payload.staticSummary) {
    lines.push(`staticEdges=${payload.staticSummary.staticEdgeCount}`)
    lines.push(`staticMethods=navigateTo:${payload.staticSummary.hasNavigateTo ? 'yes' : 'no'} reLaunch:${payload.staticSummary.hasReLaunch ? 'yes' : 'no'} switchTab:${payload.staticSummary.hasSwitchTab ? 'yes' : 'no'} navigateBack:${payload.staticSummary.hasNavigateBack ? 'yes' : 'no'}`)
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
