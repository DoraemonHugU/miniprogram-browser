const test = require('node:test')
const assert = require('node:assert/strict')

const {
  captureScreenshotToPath,
  cleanupMiniProgram,
  readRuntimeTree,
  shutdownMiniProgram,
  snapshotInteractive,
  queryRecords,
  resolveTarget,
  applySnapshotOptions,
  getStoredRuntimeEvents,
  clearStoredRuntimeEvents,
  formatConsoleEventLine,
  formatExceptionEventLine,
  ensureRouteTimelineMonitor,
  syncRouteTimelineEvents,
  getStoredRouteTimeline,
  clearStoredRouteTimeline,
  formatRouteTimelineLine,
  evaluateInMiniProgram,
  callNativeMethod,
  getElementAttribute,
  getElementProperty,
  getElementRect,
  syncCurrentRoute,
  buildNativeDiagnostic,
  buildClickNotices,
  formatAutomationCliError,
  callWxMethod,
  callPageMethod,
  buildAutomationArgs,
  connectOrEnable,
} = require('../scripts/lib/runtime.cjs')

function createState() {
  return {
    epoch: 0,
    nextRefIndex: 1,
    refs: {},
    config: {},
  }
}

test('snapshotInteractive rebuilds semantic refs from runtime tree', async () => {
  const page = {
    path: 'pages/dashboard/index',
    async $$(selector) {
      if (selector === 'view') {
        return [
          {
            tagName: 'view',
            async text() {
              return '保存'
            },
            async outerWxml() {
              return '<view data-sid="root"><view data-sid="cta" hover-class="hover"><text data-sid="label">保存</text></view></view>'
            },
          },
          {
            tagName: 'view',
            async text() {
              return '保存'
            },
            async outerWxml() {
              return '<view data-sid="cta" hover-class="hover"><text data-sid="label">保存</text></view>'
            },
          },
        ]
      }

      if (selector === 'text') {
        return [
          {
            tagName: 'text',
            async text() {
              return '保存'
            },
            async outerWxml() {
              return '<text data-sid="label">保存</text>'
            },
          },
        ]
      }

      return []
    },
  }

  const result = await snapshotInteractive(page, createState())
  assert.equal(result.records.length, 1)
  assert.equal(result.records[0].kind, 'button')
  assert.equal(result.records[0].text, '保存')
  assert.equal(result.lines[0], '@e1 [button] 保存')
})

test('readRuntimeTree rebuilds nested structure from runtime outerWxml', async () => {
  const page = {
    path: 'pages/dashboard/index',
    query: {},
    async $$(selector) {
      if (selector === 'view') {
        return [
          {
            tagName: 'view',
            async text() {
              return '保存'
            },
            async outerWxml() {
              return '<view data-sid="root"><view data-sid="cta" hover-class="hover"><text data-sid="label">保存</text></view></view>'
            },
          },
          {
            tagName: 'view',
            async text() {
              return '保存'
            },
            async outerWxml() {
              return '<view data-sid="cta" hover-class="hover"><text data-sid="label">保存</text></view>'
            },
          },
        ]
      }

      if (selector === 'text') {
        return [
          {
            tagName: 'text',
            async text() {
              return '保存'
            },
            async outerWxml() {
              return '<text data-sid="label">保存</text>'
            },
          },
        ]
      }

      return []
    },
  }

  const tree = await readRuntimeTree(page)
  assert.equal(tree.pageKey, 'pages/dashboard/index')
  assert.equal(tree.nodes.length, 1)
  assert.equal(tree.nodes[0].businessKey, 'data-sid:cta')
  assert.equal(tree.nodes[0].kind, 'button')
  assert.deepEqual(tree.nodes[0].children, [])
})

test('readRuntimeTree keeps clickable wrapper as button with combined text', async () => {
  const page = {
    path: 'pages/settings/index',
    query: {},
    async $$(selector) {
      if (selector === 'view') {
        return [
          {
            tagName: 'view',
            async text() {
              return '反馈建议 把想法告诉我们 ›'
            },
            async outerWxml() {
              return '<view class="list-item" bindtap="noop"><text>反馈建议</text><text>把想法告诉我们</text><text>›</text></view>'
            },
          },
        ]
      }

      if (selector === 'text') {
        return [
          {
            tagName: 'text',
            async text() {
              return '反馈建议'
            },
            async outerWxml() {
              return '<text>反馈建议</text>'
            },
          },
        ]
      }

      return []
    },
  }

  const tree = await readRuntimeTree(page)
  assert.equal(tree.nodes.length, 1)
  assert.equal(tree.nodes[0].kind, 'button')
  assert.equal(tree.nodes[0].text, '反馈建议 把想法告诉我们 ›')
})

test('snapshotInteractive adds contextual labels for list items under section titles', async () => {
  const page = {
    path: 'pages/dashboard/index',
    async $$(selector) {
      if (selector === 'view') {
        return [
          {
            tagName: 'view',
            async text() {
              return '今日待办 冒烟测试待办 今天 19:00'
            },
            async outerWxml() {
              return '<view data-sid="root"><text data-sid="section-title">今日待办</text><view data-sid="todo-item" hover-class="hover"><text>冒烟测试待办</text><text>今天 19:00</text></view></view>'
            },
          },
          {
            tagName: 'view',
            async text() {
              return '冒烟测试待办 今天 19:00'
            },
            async outerWxml() {
              return '<view data-sid="todo-item" hover-class="hover"><text>冒烟测试待办</text><text>今天 19:00</text></view>'
            },
          },
        ]
      }

      if (selector === 'text') {
        return [
          {
            tagName: 'text',
            async text() {
              return '今日待办'
            },
            async outerWxml() {
              return '<text data-sid="section-title">今日待办</text>'
            },
          },
        ]
      }

      return []
    },
  }

  const result = await snapshotInteractive(page, createState())
  assert.equal(result.records.length, 1)
  assert.equal(result.records[0].kind, 'button')
  assert.equal(result.records[0].text, '冒烟测试待办 今天 19:00 <今日待办>')
})

test('queryRecords rejects unsupported query modes', async () => {
  const page = {
    path: 'pages/dashboard/index',
  }

  await assert.rejects(
    queryRecords(page, createState(), 'testid', 'todo.save'),
    /unsupported query mode/i,
  )
})

test('queryRecords business mode uses rebuilt runtime tree', async () => {
  const page = {
    path: 'pages/dashboard/index',
    query: {},
    async $$(selector) {
      if (selector === 'view') {
        return [
          {
            tagName: 'view',
            async text() {
              return '保存'
            },
            async outerWxml() {
              return '<view id="save-btn" data-sid="save-btn" hover-class="hover">保存</view>'
            },
          },
        ]
      }

      return []
    },
  }

  const result = await queryRecords(page, createState(), 'business', 'data-sid:save-btn')
  assert.equal(result.records.length, 1)
  assert.equal(result.records[0].businessKey, 'data-sid:save-btn')
  assert.equal(result.records[0].strategy.selector, '[id="save-btn"]')
})

test('applySnapshotOptions compact flattens empty view containers', () => {
  const nodes = [
    {
      kind: 'view',
      tagName: 'view',
      text: '',
      children: [
        { kind: 'text', text: '晚上好', children: [] },
        { kind: 'button', text: '开始', children: [] },
      ],
    },
  ]

  const result = applySnapshotOptions(nodes, { compact: true })
  assert.deepEqual(result.map((item) => item.kind), ['text', 'button'])
})

test('snapshotInteractive applies depth limit before ref allocation', async () => {
  const page = {
    path: 'pages/dashboard/index',
    async $$(selector) {
      if (selector === 'view') {
        return [
          {
            tagName: 'view',
            async text() {
              return 'A'
            },
            async outerWxml() {
              return '<view data-sid="root"><view data-sid="panel"><view data-sid="cta" hover-class="hover">开始</view></view></view>'
            },
          },
          {
            tagName: 'view',
            async text() {
              return 'A'
            },
            async outerWxml() {
              return '<view data-sid="panel"><view data-sid="cta" hover-class="hover">开始</view></view>'
            },
          },
          {
            tagName: 'view',
            async text() {
              return '开始'
            },
            async outerWxml() {
              return '<view data-sid="cta" hover-class="hover">开始</view>'
            },
          },
        ]
      }

      return []
    },
  }

  const result = await snapshotInteractive(page, createState(), null, { depth: 1 })
  assert.equal(result.records.length, 1)
  assert.equal(result.records[0].kind, 'button')
})

test('snapshotInteractive compact view reuses canonical refs from full snapshot', async () => {
  const page = {
    path: 'pages/dashboard/index',
    async $$(selector) {
      if (selector === 'view') {
        return [
          {
            tagName: 'view',
            async text() {
              return '首页 工具箱 我的'
            },
            async outerWxml() {
              return '<view data-sid="root"><view data-sid="tabbar"><button data-sid="home">首页</button><button data-sid="tools">工具箱</button><button data-sid="profile">我的</button></view></view>'
            },
          },
          {
            tagName: 'view',
            async text() {
              return '首页 工具箱 我的'
            },
            async outerWxml() {
              return '<view data-sid="tabbar"><button data-sid="home">首页</button><button data-sid="tools">工具箱</button><button data-sid="profile">我的</button></view>'
            },
          },
        ]
      }

      if (selector === 'button') {
        return [
          {
            tagName: 'button',
            async text() {
              return '首页'
            },
            async outerWxml() {
              return '<button data-sid="home">首页</button>'
            },
          },
          {
            tagName: 'button',
            async text() {
              return '工具箱'
            },
            async outerWxml() {
              return '<button data-sid="tools">工具箱</button>'
            },
          },
          {
            tagName: 'button',
            async text() {
              return '我的'
            },
            async outerWxml() {
              return '<button data-sid="profile">我的</button>'
            },
          },
        ]
      }

      return []
    },
  }

  const full = await snapshotInteractive(page, createState())
  const compact = await snapshotInteractive(page, full.state, null, { compact: true })

  assert.deepEqual(full.records.map((record) => [record.text, record.ref]), [
    ['', '@e1'],
    ['首页', '@e2'],
    ['工具箱', '@e3'],
    ['我的', '@e4'],
  ])
  assert.deepEqual(compact.records.map((record) => [record.text, record.ref]), [
    ['首页', '@e2'],
    ['工具箱', '@e3'],
    ['我的', '@e4'],
  ])
})

test('getStoredRuntimeEvents returns latest console entries with limit', () => {
  const state = createState()
  state.consoleEvents = [
    { type: 'log', args: ['a'] },
    { type: 'warn', args: ['b'] },
    { type: 'error', args: ['c'] },
  ]

  const result = getStoredRuntimeEvents(state, 'console', { limit: 2 })
  assert.deepEqual(result.map((item) => item.type), ['warn', 'error'])
})

test('clearStoredRuntimeEvents clears exception buffer', () => {
  const state = createState()
  state.exceptionEvents = [{ message: 'boom' }]
  clearStoredRuntimeEvents(state, 'exception')
  assert.deepEqual(state.exceptionEvents, [])
})

test('formatRuntimeEvent helpers produce readable lines', () => {
  assert.equal(
    formatConsoleEventLine({ type: 'warn', args: ['hello', { code: 1 }] }),
    'warn hello {"code":1}',
  )
  assert.equal(
    formatExceptionEventLine({ message: 'TypeError: boom' }),
    'TypeError: boom',
  )
})

test('callWxMethod parses JSON-like arguments', async () => {
  const miniProgram = {
    async callWxMethod(method, ...args) {
      assert.equal(method, 'requestSubscribeMessage')
      assert.deepEqual(args, [['a', 'b'], { foo: true }, 3])
      return { ok: true }
    },
  }

  const result = await callWxMethod(miniProgram, 'requestSubscribeMessage', ['["a","b"]', '{"foo":true}', '3'])
  assert.deepEqual(result, { ok: true })
})

test('callPageMethod parses JSON-like arguments', async () => {
  const page = {
    async callMethod(method, ...args) {
      assert.equal(method, 'openSheet')
      assert.deepEqual(args, ['todo', { force: false }])
      return 1
    },
  }

  const result = await callPageMethod(page, 'openSheet', ['todo', '{"force":false}'])
  assert.equal(result, 1)
})

test('route timeline monitor records from -> to transitions', async () => {
  const originalWx = global.wx
  const originalGetCurrentPages = global.getCurrentPages
  let routeListener

  global.wx = {
    onAppRoute(listener) {
      routeListener = listener
    },
  }
  global.getCurrentPages = () => [{ route: 'pages/account/index' }]

  const miniProgram = {
    async evaluate(task) {
      return task()
    },
  }
  const state = createState()

  try {
    await ensureRouteTimelineMonitor(miniProgram)
    routeListener({ path: 'pages/login/index', openType: 'redirectTo' })

    const result = await syncRouteTimelineEvents(miniProgram, state)
    assert.equal(result.events.length, 1)
    assert.equal(result.events[0].from, 'pages/account/index')
    assert.equal(result.events[0].to, 'pages/login/index')
    assert.equal(result.events[0].openType, 'redirectTo')
    assert.equal(result.events[0].kind, 'route')
    assert.match(result.events[0].message, /account\/index -> pages\/login\/index/)
    assert.equal(state.lastRouteEventSeq, 1)
  } finally {
    global.wx = originalWx
    global.getCurrentPages = originalGetCurrentPages
    delete global.__MPB_ROUTE_MONITOR_INSTALLED__
    delete global.__MPB_ROUTE_EVENTS__
    delete global.__MPB_ROUTE_SEQ__
    delete global.__MPB_LAST_ROUTE_PATH__
  }
})

test('route timeline helpers expose latest entries and support clear', () => {
  const state = createState()
  state.routeEvents = [
    { ts: 1, kind: 'route', message: 'a -> b' },
    { ts: 2, kind: 'route', message: 'b -> c' },
    { ts: 3, kind: 'route', message: 'c -> d' },
  ]

  const recent = getStoredRouteTimeline(state, { limit: 2 })
  assert.deepEqual(recent.map((item) => item.message), ['b -> c', 'c -> d'])
  assert.equal(formatRouteTimelineLine(recent[1]), 'c -> d')

  clearStoredRouteTimeline(state)
  assert.deepEqual(state.routeEvents, [])
})

test('evaluateInMiniProgram wraps expression source into function declaration', async () => {
  const miniProgram = {
    async evaluate(source) {
      assert.equal(source, 'function () { return ((() => 42)()) }')
      return 42
    },
  }

  const result = await evaluateInMiniProgram(miniProgram, '(() => 42)()')
  assert.equal(result, 42)
})

test('callNativeMethod dispatches to native bridge with parsed args', async () => {
  const miniProgram = {
    native() {
      return {
        async switchTab(options) {
          assert.deepEqual(options, { url: '/pages/dashboard/index' })
          return { ok: true }
        },
      }
    },
  }

  const result = await callNativeMethod(miniProgram, 'switchTab', ['{"url":"/pages/dashboard/index"}'])
  assert.deepEqual(result, { ok: true })
})

test('element detail helpers expose attr prop and rect', async () => {
  const element = {
    async attribute(name) {
      assert.equal(name, 'class')
      return 'hero-name'
    },
    async property(name) {
      assert.equal(name, 'dataset')
      return { sid: 'hero-name' }
    },
    async size() {
      return { width: '100', height: '20' }
    },
    async offset() {
      return { left: 8, top: 16 }
    },
  }

  assert.equal(await getElementAttribute(element, 'class'), 'hero-name')
  assert.deepEqual(await getElementProperty(element, 'dataset'), { sid: 'hero-name' })
  assert.deepEqual(await getElementRect(element), {
    size: { width: '100', height: '20' },
    offset: { left: 8, top: 16 },
  })
})

test('syncCurrentRoute refreshes persisted route from live mini program', async () => {
  const state = createState()
  state.route = 'pages/old/index'

  await syncCurrentRoute(state, {
    async currentPage() {
      return { path: 'pages/dashboard/index' }
    },
  })

  assert.equal(state.route, 'pages/dashboard/index')
})

test('buildNativeDiagnostic explains failed native switchTab', () => {
  const diagnostic = buildNativeDiagnostic('switchTab', { error: { message: 'switchTab failed' } }, {
    pathBefore: 'pages/todo-sheet/index',
    pathAfter: 'pages/todo-sheet/index',
    routeEvents: [],
  })

  assert.match(diagnostic.message, /switchTab failed/)
  assert.match(diagnostic.hint, /tabBar|原生 tab/i)
})

test('buildNativeDiagnostic reports route change after confirmModal', () => {
  const diagnostic = buildNativeDiagnostic('confirmModal', {}, {
    pathBefore: 'pages/dashboard/index',
    pathAfter: 'pages/account-profile/index',
    routeEvents: [
      { message: 'navigateTo pages/dashboard/index -> pages/account-profile/index' },
    ],
  })

  assert.equal(diagnostic.path, 'pages/account-profile/index')
  assert.match(diagnostic.message, /已执行 native confirmModal/)
  assert.deepEqual(diagnostic.notices, ['navigateTo pages/dashboard/index -> pages/account-profile/index'])
})

test('buildNativeDiagnostic warns when confirmModal has no visible effect', () => {
  const diagnostic = buildNativeDiagnostic('confirmModal', {}, {
    pathBefore: 'pages/dashboard/index',
    pathAfter: 'pages/dashboard/index',
    routeEvents: [],
  })

  assert.match(diagnostic.message, /confirmModal 未观察到明显变化/)
  assert.match(diagnostic.hint, /当前可能没有系统 modal|logs|timeline/i)
})

test('buildClickNotices suggests checking modal when path stays unchanged', () => {
  const notices = buildClickNotices({
    pathBefore: 'pages/dashboard/index',
    pathAfter: 'pages/dashboard/index',
    routeEvents: [],
  })

  assert.equal(notices.length, 1)
  assert.match(notices[0], /登录弹窗|confirmModal|timeline/i)
})

test('formatAutomationCliError adds actionable hint for devtools port restart requirement', () => {
  const error = formatAutomationCliError(
    'IDE server has started on http://127.0.0.1:39085 and must be restarted on port 39100 first',
  )

  assert.match(error.message, /需要先把当前 DevTools HTTP 服务从 39085 重启到 39100/i)
  assert.match(error.message, /close 当前 session 或在微信开发者工具里重启服务端口/i)
})

test('connectOrEnable prefers enable-first for open-like calls', async () => {
  const calls = []
  const result = await connectOrEnable({ autoPort: 9421 }, {
    preferEnable: true,
    onProgress(phase) {
      calls.push(`progress:${phase}`)
    },
  }, {
    async connect() {
      calls.push('connect')
      return { ok: true }
    },
    enable() {
      calls.push('enable')
    },
    async sleepFn(ms) {
      calls.push(`sleep:${ms}`)
    },
  })

  assert.deepEqual(calls, [
    'progress:enable',
    'enable',
    'sleep:5000',
    'progress:connect',
    'connect',
  ])
  assert.deepEqual(result, { ok: true })
})

test('connectOrEnable reports fallback phases after initial connect failure', async () => {
  const calls = []
  let attempts = 0
  const result = await connectOrEnable({ autoPort: 9421 }, {
    onProgress(phase) {
      calls.push(`progress:${phase}`)
    },
  }, {
    async connect() {
      attempts += 1
      calls.push(`connect:${attempts}`)
      if (attempts === 1) {
        throw new Error('first connect failed')
      }
      return { ok: true }
    },
    enable() {
      calls.push('enable')
    },
    async sleepFn(ms) {
      calls.push(`sleep:${ms}`)
    },
  })

  assert.deepEqual(calls, [
    'progress:connect',
    'connect:1',
    'progress:enable',
    'enable',
    'sleep:5000',
    'progress:connect',
    'connect:2',
  ])
  assert.deepEqual(result, { ok: true })
})

test('buildAutomationArgs uses project path and auto-port without forcing HTTP port', () => {
  const result = buildAutomationArgs({
    cliPath: '/mnt/f/Tools/wxwebtool/cli.bat',
    projectPath: '/home/wang/demo/apps/miniprogram',
    autoPort: '9421',
    devtoolsPort: '39085',
  })

  assert.deepEqual(result.args.slice(0, 2), ['auto', '--project'])
  assert.equal(result.args.includes('--port'), false)
  assert.deepEqual(result.args.slice(-2), ['--auto-port', '9421'])
})

test('queryRecords selector mode still uses official selector lookup', async () => {
  const page = {
    path: 'pages/dashboard/index',
    async $$(selector) {
      assert.equal(selector, '.dashboard-add-button')
      return [
        {
          tagName: 'view',
          async text() {
            return '+'
          },
          async attribute(name) {
            assert.equal(name, 'class')
            return 'dashboard-add-button'
          },
        },
      ]
    },
  }

  const result = await queryRecords(page, createState(), 'selector', '.dashboard-add-button')
  assert.equal(result.records.length, 1)
  assert.equal(result.records[0].strategy.selector, '.dashboard-add-button')
  assert.deepEqual(result.lines, ['@e1 [view] +'])
})

test('readRuntimeTree uses attribute selector for ids that are not valid CSS identifiers', async () => {
  const page = {
    path: 'pages/tools/index',
    async $$(tagName) {
      if (tagName === 'view') {
        return [
          {
            tagName: 'view',
            async outerWxml() {
              return '<view id="79c6a90d--_Bg" bindtap="onTap">工具箱</view>'
            },
            async text() {
              return '工具箱'
            },
          },
        ]
      }
      return []
    },
  }

  const tree = await readRuntimeTree(page)
  assert.equal(tree.nodes[0].selector, '[id="79c6a90d--_Bg"]')
})

test('queryRecords selector mode keeps all official matches', async () => {
  const page = {
    path: 'pages/dashboard/index',
    async $$(selector) {
      assert.equal(selector, '.dashboard-tab')
      return [
        {
          tagName: 'view',
          async text() {
            return '首页'
          },
          async attribute() {
            return 'dashboard-tab'
          },
        },
        {
          tagName: 'view',
          async text() {
            return '首页'
          },
          async attribute() {
            return 'dashboard-tab'
          },
        },
      ]
    },
  }

  const result = await queryRecords(page, createState(), 'selector', '.dashboard-tab')
  assert.equal(result.records.length, 2)
  assert.deepEqual(result.lines, ['@e1 [view] 首页', '@e2 [view] 首页'])
})

test('resolveTarget rejects stale refs from another route', async () => {
  const page = {
    path: 'pages/tools/index',
    async $$() {
      throw new Error('selector resolution should not happen')
    },
  }

  const state = {
    epoch: 1,
    refs: {
      '@e1': {
        ref: '@e1',
        epoch: 1,
        route: 'pages/dashboard/index',
        scopeRef: null,
        strategy: {
          kind: 'selector',
          value: '.dashboard-add-button',
          selector: '.dashboard-add-button',
          index: 0,
        },
      },
    },
  }

  await assert.rejects(
    resolveTarget(page, state, '@e1'),
    /route/i,
  )
})

test('captureScreenshotToPath fails fast on timeout', async () => {
  const miniProgram = {
    screenshot() {
      return new Promise(() => {})
    },
  }

  await assert.rejects(async () => {
    await captureScreenshotToPath(miniProgram, '/tmp/shot.png', 20)
  }, (error) => {
    assert.match(error.message, /screenshot timeout/i)
    assert.match(error.message, /close .* open/i)
    return true
  })
})

test('cleanupMiniProgram prefers disconnect over close', async () => {
  const calls = []
  const miniProgram = {
    async disconnect() {
      calls.push('disconnect')
    },
    async close() {
      calls.push('close')
    },
  }

  await cleanupMiniProgram(miniProgram)
  assert.deepEqual(calls, ['disconnect'])
})

test('shutdownMiniProgram prefers close for session shutdown', async () => {
  const calls = []
  const miniProgram = {
    async disconnect() {
      calls.push('disconnect')
    },
    async close() {
      calls.push('close')
    },
  }

  await shutdownMiniProgram(miniProgram)
  assert.deepEqual(calls, ['close'])
})
