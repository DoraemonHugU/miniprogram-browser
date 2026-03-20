const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  parseRouteConstantsFromSource,
  parseStaticEdgesFromSource,
  buildStaticSummary,
  buildCurrentOutgoingEdges,
  dedupeStaticEdges,
  normalizeInspectSections,
  inspectProjectStructure,
  resolveStaticRoots,
} = require('../scripts/lib/app-inspect.cjs')

test('parseRouteConstantsFromSource extracts route constants object literals', () => {
  const constants = parseRouteConstantsFromSource(`
    export const SUB_ROUTES = {
      todoSheet: '/pages/todo-sheet/index',
      accountProfile: '/pages/account-profile/index?from=guard',
    }
  `)

  assert.deepEqual(constants, {
    'SUB_ROUTES.todoSheet': 'pages/todo-sheet/index',
    'SUB_ROUTES.accountProfile': 'pages/account-profile/index',
  })
})

test('parseStaticEdgesFromSource captures literal and constant-based navigation calls', () => {
  const routeConstants = {
    'SUB_ROUTES.todoSheet': 'pages/todo-sheet/index',
  }
  const edges = parseStaticEdgesFromSource({
    source: `
      await Taro.navigateTo({ url: SUB_ROUTES.todoSheet })
      await Taro.reLaunch({ url: '/pages/dashboard/index?tab=home' })
      await Taro.navigateBack()
    `,
    filePath: '/repo/src/pages/dashboard/index.tsx',
    srcRoot: '/repo/src',
    routeConstants,
  })

  assert.deepEqual(edges, [
    {
      from: 'pages/dashboard/index',
      to: 'pages/todo-sheet/index',
      method: 'navigateTo',
      source: 'SUB_ROUTES.todoSheet',
      file: 'pages/dashboard/index.tsx',
    },
    {
      from: 'pages/dashboard/index',
      to: 'pages/dashboard/index',
      method: 'reLaunch',
      source: '/pages/dashboard/index?tab=home',
      file: 'pages/dashboard/index.tsx',
    },
    {
      from: 'pages/dashboard/index',
      to: null,
      method: 'navigateBack',
      source: null,
      file: 'pages/dashboard/index.tsx',
    },
  ])
})

test('buildStaticSummary reduces static edges to counts', () => {
  const summary = buildStaticSummary([
    { method: 'navigateTo' },
    { method: 'navigateTo' },
    { method: 'reLaunch' },
    { method: 'switchTab' },
  ], {
    'SUB_ROUTES.todoSheet': 'pages/todo-sheet/index',
  })

  assert.deepEqual(summary, {
    staticEdgeCount: 4,
    hasNavigateTo: true,
    hasReLaunch: true,
    hasSwitchTab: true,
    hasNavigateBack: false,
    routeConstantsCount: 1,
  })
})

test('normalizeInspectSections expands defaults and all', () => {
  assert.deepEqual(normalizeInspectSections({}), [
    'pagesSummary',
    'tabBarSummary',
    'state',
    'recentRoutes',
    'currentOutgoingEdges',
    'staticSummary',
  ])

  assert.deepEqual(normalizeInspectSections({ all: true }), [
    'pagesSummary',
    'tabBarSummary',
    'state',
    'recentRoutes',
    'currentOutgoingEdges',
    'staticSummary',
    'pages',
    'tabbar',
    'observedEdges',
    'staticEdges',
    'routeConstants',
  ])
})

test('buildCurrentOutgoingEdges highlights current page direct edges and observed ones', () => {
  const result = buildCurrentOutgoingEdges('pages/dashboard/index', [
    { from: 'pages/dashboard/index', to: 'pages/todo-sheet/index', method: 'navigateTo' },
    { from: 'pages/dashboard/index', to: 'pages/tool-management/index', method: 'navigateTo' },
    { from: 'pages/settings/index', to: 'pages/account-profile/index', method: 'navigateTo' },
  ], [
    { from: 'pages/dashboard/index', to: 'pages/todo-sheet/index', method: 'navigateTo' },
  ])

  assert.deepEqual(result, [
    { to: 'pages/todo-sheet/index', methods: ['navigateTo'], observed: true },
    { to: 'pages/tool-management/index', methods: ['navigateTo'], observed: false },
  ])
})

test('dedupeStaticEdges removes logical duplicates across scan roots', () => {
  const result = dedupeStaticEdges([
    { from: 'pages/dashboard/index', to: 'pages/todo-sheet/index', method: 'navigateTo', source: '/pages/todo-sheet/index', file: 'src/pages/dashboard/index.tsx' },
    { from: 'pages/dashboard/index', to: 'pages/todo-sheet/index', method: 'navigateTo', source: '/pages/todo-sheet/index', file: 'dist/pages/dashboard/index.js' },
    { from: 'pages/dashboard/index', to: 'pages/account-profile/index', method: 'navigateTo', source: '/pages/account-profile/index', file: 'dist/pages/dashboard/index.js' },
  ])

  assert.deepEqual(result, [
    { from: 'pages/dashboard/index', to: 'pages/todo-sheet/index', method: 'navigateTo', source: '/pages/todo-sheet/index', file: 'src/pages/dashboard/index.tsx' },
    { from: 'pages/dashboard/index', to: 'pages/account-profile/index', method: 'navigateTo', source: '/pages/account-profile/index', file: 'dist/pages/dashboard/index.js' },
  ])
})

test('inspectProjectStructure reads runtime config and source graph summary', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mpb-inspect-'))
  try {
    await fs.promises.mkdir(path.join(tempDir, 'src/pages/dashboard'), { recursive: true })
    await fs.promises.mkdir(path.join(tempDir, 'src/constants'), { recursive: true })
    await fs.promises.writeFile(path.join(tempDir, 'project.config.json'), JSON.stringify({ miniprogramRoot: 'dist/' }))
    await fs.promises.writeFile(path.join(tempDir, 'src/constants/routes.ts'), `
      export const SUB_ROUTES = {
        todoSheet: '/pages/todo-sheet/index',
      }
    `)
    await fs.promises.writeFile(path.join(tempDir, 'src/pages/dashboard/index.tsx'), `
      import { SUB_ROUTES } from '@/constants/routes'
      void Taro.navigateTo({ url: SUB_ROUTES.todoSheet })
    `)

    const result = await inspectProjectStructure({
      projectPath: tempDir,
      runtimeConfig: {
        pages: ['pages/dashboard/index', 'pages/todo-sheet/index'],
        tabBar: { list: [] },
        entryPagePath: 'pages/dashboard/index',
      },
      current: 'pages/dashboard/index',
      pageStack: [{ path: 'pages/dashboard/index' }],
      recentRoutes: [{ ts: 1, kind: 'route', message: 'navigateTo pages/dashboard/index -> pages/todo-sheet/index' }],
      observedEdges: [{ from: 'pages/dashboard/index', to: 'pages/todo-sheet/index', method: 'navigateTo' }],
      sections: normalizeInspectSections({}),
    })

    assert.deepEqual(result.pagesSummary, {
      count: 2,
      entryPagePath: 'pages/dashboard/index',
    })
    assert.deepEqual(result.tabBarSummary, { count: 0, pages: [] })
    assert.equal(result.current, 'pages/dashboard/index')
    assert.deepEqual(result.recentRoutes, ['navigateTo pages/dashboard/index -> pages/todo-sheet/index'])
    assert.deepEqual(result.currentOutgoingEdges, [
      { to: 'pages/todo-sheet/index', methods: ['navigateTo'], observed: true },
    ])
    assert.equal(result.staticSummary.staticEdgeCount, 1)
    assert.equal(result.staticSummary.routeConstantsCount, 1)
    assert.equal(result.sections.includes('staticEdges'), false)
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true })
  }
})

test('resolveStaticRoots prefers miniprogramRoot from project config before src', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mpb-roots-'))
  try {
    await fs.promises.mkdir(path.join(tempDir, 'src'), { recursive: true })
    await fs.promises.mkdir(path.join(tempDir, 'build/mp-weixin'), { recursive: true })
    await fs.promises.writeFile(path.join(tempDir, 'project.config.json'), JSON.stringify({
      miniprogramRoot: 'build/mp-weixin/',
    }))

    const result = await resolveStaticRoots(tempDir)
    assert.deepEqual(result.scanRoots, [
      path.join(tempDir, 'build/mp-weixin'),
      path.join(tempDir, 'src'),
    ])
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true })
  }
})
