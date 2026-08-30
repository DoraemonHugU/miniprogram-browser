const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  captureScreenshotToPath,
  cleanupMiniProgram,
  readRuntimeTree,
  subtreeForScope,
  shutdownMiniProgram,
  snapshotInteractive,
  queryRecords,
  resolveTarget,
  resolveActionTarget,
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
  confirmRouteAfterAction,
  formatAutomationCliError,
  parseAutomationCliFailure,
  explainDevtoolsFailureRaw,
  summarizeDevtoolsCliRaw,
  detectAutomationCliProgressTimeout,
  validateAutomationCliConfig,
  parseResolvedIdePort,
  enableAutomation,
  closeDevtoolsProject,
  callWxMethod,
  changeMiniProgramRoute,
  callPageMethod,
  buildAutomationArgs,
  connectWithRetry,
  // buildConnectRetryOptions removed in simplification
  connectOrEnable,
  withMiniProgram,
  probeAutomationRuntime,
  sendAutomationProtocol,
  collectDevtoolsLogs,
  normalizeAwaitCondition,
  resolveAwaitTimeoutMs,
  waitForMiniProgramCondition,
  waitForMiniProgramStable,
  extractLogSummary,
} = require('../dist/lib/runtime.js')

function createState() {
  return {
    epoch: 0,
    nextRefIndex: 1,
    refs: {},
    config: {},
  }
}

const WSL_TEST_OPTIONS = {
  runtime: 'linux',
  readProcVersion: '5.15.0-microsoft-standard-WSL2',
  wslDistroName: 'ubuntu-test',
}

function createInteractivePage(labels) {
  const rootWxml = `<view>${labels.map((label) => `<view hover-class="hover"><text>${label}</text></view>`).join('')}</view>`
  return {
    path: 'pages/tools/index',
    async $$(selector) {
      if (selector === 'view') {
        return [
          {
            tagName: 'view',
            async text() {
              return labels.join(' ')
            },
            async outerWxml() {
              return rootWxml
            },
          },
          ...labels.map((label) => ({
            tagName: 'view',
            async text() {
              return label
            },
            async outerWxml() {
              return `<view hover-class="hover"><text>${label}</text></view>`
            },
          })),
        ]
      }

      if (selector === 'text') {
        return labels.map((label) => ({
          tagName: 'text',
          async text() {
            return label
          },
          async outerWxml() {
            return `<text>${label}</text>`
          },
        }))
      }

      return []
    },
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

test('snapshotInteractive rebuilds deterministic refs for every full snapshot', async () => {
  const firstPage = createInteractivePage(['Alpha', 'Beta'])
  const secondPage = {
    ...createInteractivePage(['Gamma']),
    path: 'pages/other/index',
  }

  const first = await snapshotInteractive(firstPage, createState())
  const second = await snapshotInteractive(secondPage, first.state)
  const firstAgain = await snapshotInteractive(firstPage, second.state)

  assert.deepEqual(
    firstAgain.records.map((record) => [record.ref, record.text]),
    first.records.map((record) => [record.ref, record.text]),
  )
  assert.equal(second.records[0].ref, '@e1')
  assert.equal(Object.keys(second.state.refs).length, second.records.length)
  assert.equal(second.state.nextRefIndex, second.records.length + 1)
})

test('resolveTarget re-resolves reordered view refs by semantic identity', async () => {
  const state = createState()
  const initialPage = createInteractivePage(['Alpha', 'Beta'])
  const snapshotResult = await snapshotInteractive(initialPage, state)
  const betaRecord = snapshotResult.records[snapshotResult.records.length - 1]

  const reorderedPage = createInteractivePage(['Beta', 'Alpha'])
  const element = await resolveTarget(reorderedPage, snapshotResult.state, betaRecord.ref)

  assert.equal(await element.text(), 'Beta')
})

test('resolveActionTarget prefers the containing label for checkbox and radio refs', async () => {
  const checkbox = {
    tagName: 'checkbox',
    async outerWxml() { return '<checkbox value="alpha" checked="false"></checkbox>' },
  }
  const label = {
    tagName: 'label',
    async outerWxml() { return '<label><checkbox value="alpha" checked="false"></checkbox>Alpha</label>' },
  }
  const page = {
    path: 'pages/controls/index',
    async $$(selector) {
      if (selector === 'checkbox') return [checkbox]
      if (selector === 'label') return [label]
      return []
    },
  }
  const state = createState()
  state.refs['@e1'] = {
    ref: '@e1',
    route: page.path,
    kind: 'checkbox',
    strategy: { kind: 'selector', selector: 'checkbox', index: 0 },
  }

  const resolved = await resolveActionTarget(page, state, '@e1')

  assert.equal(resolved.element, label)
  assert.equal(resolved.originalElement, checkbox)
  assert.equal(resolved.via, 'label')
})

test('resolveActionTarget keeps non-control targets unchanged', async () => {
  const button = { tagName: 'button' }
  const page = {
    async $(selector) { return selector === '#save' ? button : null },
  }

  const resolved = await resolveActionTarget(page, createState(), '#save')

  assert.equal(resolved.element, button)
  assert.equal(resolved.originalElement, button)
  assert.equal(resolved.via, 'target')
})

test('subtreeForScope respects pageKey with query params', async () => {
  const tree = [
    {
      businessKey: 'data-sid:filter',
      canonicalPath: 'business:data-sid:filter',
      children: [
        {
          businessKey: 'data-sid:trigger',
          canonicalPath: 'business:data-sid:filter/business:data-sid:trigger',
          children: [],
        },
      ],
    },
  ]
  const scopeRecord = {
    route: 'pages/tools/index',
    stableKey: 'pages/tools/index?tab=focus|business:data-sid:filter',
    businessKey: 'data-sid:filter',
  }

  const subtree = subtreeForScope(tree, scopeRecord, 'pages/tools/index?tab=focus')

  assert.equal(subtree.length, 1)
  assert.equal(subtree[0].businessKey, 'data-sid:trigger')
})

test('confirmRouteAfterAction waits for route change evidence', async () => {
  let evaluateCalls = 0
  let currentPageCalls = 0
  const miniProgram = {
    async evaluate() {
      evaluateCalls += 1
      if (evaluateCalls >= 2) {
        return [{ seq: 1, ts: Date.now(), from: 'pages/settings/index', to: 'pages/preferences/index', openType: 'navigateTo' }]
      }
      return []
    },
    async currentPage() {
      currentPageCalls += 1
      if (currentPageCalls >= 2) {
        return { path: 'pages/preferences/index' }
      }
      return { path: 'pages/settings/index' }
    },
  }
  const state = { routeEvents: [], lastRouteEventSeq: 0, route: 'pages/settings/index' }

  const result = await confirmRouteAfterAction(miniProgram, state, {
    pathBefore: 'pages/settings/index',
    timeoutMs: 500,
    pollMs: 1,
  })

  assert.equal(result.path, 'pages/preferences/index')
  assert.equal(result.routeEvents.length, 1)
})

test('confirmRouteAfterAction prefers route event target when currentPage lags', async () => {
  const miniProgram = {
    async evaluate() {
      return [{ seq: 1, ts: Date.now(), from: 'pages/settings/index', to: 'pages/preferences/index', openType: 'navigateTo' }]
    },
    async currentPage() {
      return { path: 'pages/settings/index' }
    },
  }
  const state = { routeEvents: [], lastRouteEventSeq: 0, route: 'pages/settings/index' }

  const result = await confirmRouteAfterAction(miniProgram, state, {
    pathBefore: 'pages/settings/index',
    timeoutMs: 20,
    pollMs: 1,
  })

  assert.equal(result.path, 'pages/preferences/index')
  assert.equal(state.route, 'pages/preferences/index')
})

test('confirmRouteAfterAction does not trust route events for an explicit expected route', async () => {
  const miniProgram = {
    async evaluate() {
      return [{ seq: 1, ts: Date.now(), from: 'pages/settings/index', to: 'pages/preferences/index', openType: 'reLaunch' }]
    },
    async currentPage() {
      return { path: 'pages/settings/index' }
    },
  }
  const state = { routeEvents: [], lastRouteEventSeq: 0, route: 'pages/settings/index' }

  const result = await confirmRouteAfterAction(miniProgram, state, {
    pathBefore: 'pages/settings/index',
    expectedPath: 'pages/preferences/index',
    timeoutMs: 20,
    pollMs: 1,
  })

  assert.equal(result.path, 'pages/settings/index')
  assert.equal(result.expectedMatched, false)
  assert.equal(state.route, 'pages/settings/index')
})

test('confirmRouteAfterAction requires stable expected route matches when requested', async () => {
  const pages = [
    'pages/settings/index',
    'pages/preferences/index',
    'pages/settings/index',
    'pages/preferences/index',
    'pages/preferences/index',
  ]
  let currentPageCalls = 0
  const miniProgram = {
    async evaluate() {
      return []
    },
    async currentPage() {
      currentPageCalls += 1
      return { path: pages.shift() || 'pages/settings/index' }
    },
  }
  const state = { routeEvents: [], lastRouteEventSeq: 0, route: 'pages/settings/index' }

  const result = await confirmRouteAfterAction(miniProgram, state, {
    pathBefore: 'pages/settings/index',
    expectedPath: 'pages/preferences/index',
    expectedStableMatches: 2,
    timeoutMs: 500,
    pollMs: 1,
  })

  assert.equal(result.path, 'pages/preferences/index')
  assert.equal(result.expectedMatched, true)
  assert.equal(currentPageCalls, 5)
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

test('readRuntimeTree raw mode keeps structural descendants', async () => {
  const page = {
    path: 'pages/dashboard/index',
    query: {},
    async $$(selector) {
      if (selector === 'view') {
        return [
          {
            tagName: 'view',
            async text() { return '保存' },
            async outerWxml() {
              return '<view data-sid="root"><view data-sid="cta" hover-class="hover"><text data-sid="label">保存</text></view></view>'
            },
          },
          {
            tagName: 'view',
            async text() { return '保存' },
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
            async text() { return '保存' },
            async outerWxml() {
              return '<text data-sid="label">保存</text>'
            },
          },
        ]
      }
      return []
    },
  }

  const tree = await readRuntimeTree(page, { raw: true })
  assert.equal(tree.nodes.length, 1)
  assert.equal(tree.nodes[0].businessKey, 'data-sid:root')
  assert.equal(tree.nodes[0].children.length, 1)
  assert.equal(tree.nodes[0].children[0].businessKey, 'data-sid:cta')
  assert.equal(tree.nodes[0].children[0].children.length, 1)
})

test('readRuntimeTree raw mode uses selector index zero for unique selectors', async () => {
  const page = {
    path: 'pages/dashboard/index',
    query: {},
    async $$(selector) {
      if (selector === 'view') {
        return [
          {
            tagName: 'view',
            async text() { return 'A' },
            async outerWxml() { return '<view id="a">A</view>' },
          },
          {
            tagName: 'view',
            async text() { return 'B' },
            async outerWxml() { return '<view id="b">B</view>' },
          },
        ]
      }
      return []
    },
  }

  const tree = await readRuntimeTree(page, { raw: true })
  assert.equal(tree.nodes[0].strategy.index, 0)
  assert.equal(tree.nodes[1].strategy.index, 0)
})

test('snapshotInteractive preserves selector indexes for duplicate controls', async () => {
  const page = {
    path: 'pages/dashboard/index',
    query: {},
    async $$(selector) {
      if (selector !== 'button') return []
      return [
        {
          tagName: 'button',
          async text() { return '提交' },
          async outerWxml() { return '<button>提交</button>' },
        },
        {
          tagName: 'button',
          async text() { return '重置' },
          async outerWxml() { return '<button>重置</button>' },
        },
      ]
    },
  }

  const result = await snapshotInteractive(page, createState())
  assert.deepEqual(result.records.map((record) => record.strategy.index), [0, 1])
})

test('resolveTarget preserves structural occurrence when duplicate controls share text', async () => {
  const controls = [
    { marker: 'add', text: 'Add', outerWxml: '<button id="list-add">Add</button>' },
    { marker: 'first-select', text: 'Select' },
    { marker: 'first-remove', text: 'Remove' },
    { marker: 'second-select', text: 'Select' },
    { marker: 'second-remove', text: 'Remove' },
  ].map(({ marker, text, outerWxml }) => ({
    marker,
    tagName: 'button',
    async text() { return text },
    async outerWxml() { return outerWxml || `<button>${text}</button>` },
  }))
  const page = {
    path: 'pages/lists/index',
    query: {},
    async $$(selector) {
      return selector === 'button' ? controls : []
    },
  }

  const result = await snapshotInteractive(page, createState())
  const secondSelect = result.records.filter((record) => record.text === 'Select')[1]
  const element = await resolveTarget(page, result.state, secondSelect.ref)

  assert.equal(element.marker, 'second-select')
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

test('readRuntimeTree keeps structural gesture targets even when descendants have no text nodes', async () => {
  const scrollWxml = '<scroll-view id="feed" scroll-y><view>Row 1</view></scroll-view>'
  const swiperWxml = '<swiper id="carousel"><swiper-item><view>Slide 1</view></swiper-item></swiper>'
  const page = {
    path: 'pages/interaction/index',
    query: {},
    async $$(selector) {
      if (selector === 'view') {
        return [
          { tagName: 'view', async text() { return 'Row 1 Slide 1' }, async outerWxml() { return `<view>${scrollWxml}${swiperWxml}</view>` } },
          { tagName: 'view', async text() { return 'Row 1' }, async outerWxml() { return '<view>Row 1</view>' } },
          { tagName: 'view', async text() { return 'Slide 1' }, async outerWxml() { return '<view>Slide 1</view>' } },
        ]
      }
      if (selector === 'scroll-view') {
        return [{ tagName: 'scroll-view', async text() { return 'Row 1' }, async outerWxml() { return scrollWxml } }]
      }
      if (selector === 'swiper') {
        return [{ tagName: 'swiper', async text() { return 'Slide 1' }, async outerWxml() { return swiperWxml } }]
      }
      if (selector === 'swiper-item') {
        return [{ tagName: 'swiper-item', async text() { return 'Slide 1' }, async outerWxml() { return '<swiper-item><view>Slide 1</view></swiper-item>' } }]
      }
      return []
    },
  }

  const tree = await readRuntimeTree(page)

  assert.deepEqual(tree.nodes.map((node) => node.kind), ['scroll-view', 'swiper'])
  assert.deepEqual(tree.nodes[1].children, [])
})

test('readRuntimeTree exposes longpress wrappers as labeled buttons', async () => {
  const page = {
    path: 'pages/interaction/index',
    query: {},
    async $$(selector) {
      if (selector !== 'view') return []
      return [{
        tagName: 'view',
        async text() { return 'Long press target' },
        async outerWxml() { return '<view id="hold" bindlongpress="onHold">Long press target</view>' },
      }]
    },
  }

  const tree = await readRuntimeTree(page)

  assert.equal(tree.nodes[0].kind, 'button')
  assert.equal(tree.nodes[0].text, 'Long press target')
})

test('readRuntimeTree keeps explicitly identified direct-text views when compiled WXML strips events', async () => {
  const page = {
    path: 'pages/interaction/index',
    query: {},
    async $$(selector) {
      if (selector !== 'view') return []
      return [{
        tagName: 'view',
        async text() { return 'Long press target' },
        async outerWxml() { return '<view id="hold">Long press target</view>' },
      }]
    },
  }

  const tree = await readRuntimeTree(page)

  assert.equal(tree.nodes[0].kind, 'view')
  assert.equal(tree.nodes[0].text, 'Long press target')
})

test('readRuntimeTree ignores compiler-generated matching id and data-sid wrappers', async () => {
  const page = {
    path: 'pages/interaction/index',
    query: {},
    async $$(selector) {
      if (selector !== 'view') return []
      return [{
        tagName: 'view',
        async text() { return 'Generated row' },
        async outerWxml() { return '<view id="_Ay" data-sid="_Ay">Generated row</view>' },
      }, {
        tagName: 'view',
        async text() { return 'Explicit action' },
        async outerWxml() { return '<view id="interaction-action" data-sid="_Az">Explicit action</view>' },
      }]
    },
  }

  const tree = await readRuntimeTree(page)

  assert.equal(tree.nodes.length, 1)
  assert.equal(tree.nodes[0].businessKey, 'id:interaction-action')
  assert.equal(tree.nodes[0].text, 'Explicit action')
})

test('snapshotInteractive keeps meaningful button labels free from unrelated section suffixes', async () => {
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
  assert.deepEqual(result.records.map((record) => [record.kind, record.text]), [
    ['text', '今日待办'],
    ['button', '冒烟测试待办 今天 19:00'],
  ])
})

test('snapshotInteractive uses a concise navigator label and removes descendant text noise', async () => {
  const navigatorWxml = '<navigator url="/pages/controls/index"><view><text>Controls</text><text>Open page →</text></view></navigator>'
  const page = {
    path: 'pages/index/index',
    query: {},
    async $$(selector) {
      if (selector === 'view') {
        return [{
          tagName: 'view',
          async text() { return 'Controls Open page →' },
          async outerWxml() { return `<view>${navigatorWxml}</view>` },
        }, {
          tagName: 'view',
          async text() { return 'Controls Open page →' },
          async outerWxml() { return '<view><text>Controls</text><text>Open page →</text></view>' },
        }]
      }
      if (selector === 'navigator') {
        return [{
          tagName: 'navigator',
          async text() { return 'Controls Open page →' },
          async outerWxml() { return navigatorWxml },
        }]
      }
      if (selector === 'text') {
        return ['Controls', 'Open page →'].map((value) => ({
          tagName: 'text',
          async text() { return value },
          async outerWxml() { return `<text>${value}</text>` },
        }))
      }
      return []
    },
  }

  const result = await snapshotInteractive(page, createState())

  assert.deepEqual(result.records.map((record) => [record.kind, record.text]), [
    ['navigator', 'Controls'],
  ])
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

  const result = await queryRecords(page, createState(), 'business', 'id:save-btn')
  assert.equal(result.records.length, 1)
  assert.equal(result.records[0].businessKey, 'id:save-btn')
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

test('applySnapshotOptions compact keeps structural gesture containers', () => {
  const nodes = [{
    kind: 'swiper',
    text: '',
    children: [{ kind: 'swiper-item', tagName: 'swiper-item', text: '', children: [] }],
  }]

  const result = applySnapshotOptions(nodes, { compact: true })

  assert.equal(result[0].kind, 'swiper')
  assert.equal(result[0].children[0].kind, 'swiper-item')
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

test('changeMiniProgramRoute calls wx directly without the automator route sleep', async () => {
  const calls = []
  const miniProgram = {
    async currentPage() {
      return { path: 'pages/index/index' }
    },
    async callWxMethod(method, options) {
      calls.push([method, options])
      return { ok: true }
    },
    async reLaunch() {
      throw new Error('must not use miniprogram-automator changeRoute')
    },
  }

  const result = await changeMiniProgramRoute(miniProgram, 'reLaunch', '/pages/detail/index')

  assert.deepEqual(result, { ok: true })
  assert.deepEqual(calls, [['reLaunch', { url: '/pages/detail/index' }]])
})

test('changeMiniProgramRoute preserves plugin route dispatch', async () => {
  const calls = []
  const miniProgram = {
    async currentPage() {
      return { path: 'plugin-private://demo-plugin/pages/index' }
    },
    async callPluginWxMethod(pluginId, method, options) {
      calls.push([pluginId, method, options])
      return { ok: true }
    },
  }

  await changeMiniProgramRoute(miniProgram, 'switchTab', '/pages/tools/index')

  assert.deepEqual(calls, [['demo-plugin', 'switchTab', { url: '/pages/tools/index' }]])
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

test('buildClickNotices keeps successful same-page clicks free of speculative navigation warnings', () => {
  const notices = buildClickNotices({
    pathBefore: 'pages/dashboard/index',
    pathAfter: 'pages/dashboard/index',
    routeEvents: [],
  })

  assert.deepEqual(notices, [])
})

test('buildClickNotices keeps observed route events visible', () => {
  const notices = buildClickNotices({
    pathBefore: 'pages/dashboard/index',
    pathAfter: 'pages/detail/index',
    routeEvents: [{ message: 'navigateTo pages/dashboard/index -> pages/detail/index' }],
  })

  assert.deepEqual(notices, ['navigateTo pages/dashboard/index -> pages/detail/index'])
})

test('formatAutomationCliError explains login token expiry and keeps raw', () => {
  const raw = [
    '[error] {',
    "  code: 10,",
    "  message: 'Error: × Error: INVALID_LOGIN,access_token expired [20260719 10:56:55][] (code 10)'",
    '}',
  ].join('\n')
  const error = formatAutomationCliError(raw)
  assert.match(error.message, /登录态失效|access_token|INVALID_LOGIN/i)
  assert.match(error.raw, /INVALID_LOGIN,access_token expired/)
})

test('parseAutomationCliFailure explains INVALID_LOGIN from CLI output with raw preserved', () => {
  const raw = [
    '√ IDE server started successfully, listening on http://127.0.0.1:63870',
    '- preparing',
    '[error] {',
    "  code: 10,",
    "  message: 'Error: INVALID_LOGIN,access_token expired'",
    '}',
  ].join('\n')
  const failure = parseAutomationCliFailure({ status: 1, raw }, { cliPath: '/mnt/f/tools/wechat-devtools/cli.js' })
  assert.ok(failure)
  assert.match(failure.message, /登录态失效|INVALID_LOGIN|access_token/i)
  assert.match(failure.raw, /INVALID_LOGIN,access_token expired/)
  assert.match(String(failure.hint || ''), /INVALID_LOGIN|access_token|code:\s*10/i)
})

test('parseAutomationCliFailure does not treat successful auto log with Fetching AppID as AppID failure', () => {
  const raw = [
    '- Fetching AppID () permissions',
    '✔ Using AppID: wx-test-appid',
    '✔ auto',
    '[info] long connection established',
  ].join('\n')
  assert.equal(parseAutomationCliFailure({ status: 0, raw }, {}), null)
  assert.equal(parseAutomationCliFailure({ status: 1, raw }, {}), null)
  assert.equal(explainDevtoolsFailureRaw(raw), null)
})

test('parseAutomationCliFailure still explains real AppID missing without Using AppID success', () => {
  const raw = [
    '- Fetching AppID () permissions',
    '[error] errcode=41002 appid missing',
  ].join('\n')
  const failure = parseAutomationCliFailure({ status: 1, raw }, {})
  assert.ok(failure)
  assert.match(failure.message, /AppID|41002|appid missing/i)
  assert.match(failure.raw, /41002|appid missing/i)
})

test('summarizeDevtoolsCliRaw keeps signal lines and bounds output', () => {
  const raw = [
    'debug fluff line 1',
    'debug fluff line 2',
    '[error] errcode=41002 appid missing',
    'more fluff',
    '✔ Using AppID: wx123',
    'noise',
    'start cli server error',
    ...Array.from({ length: 40 }, (_, i) => `padding ${i}`),
  ].join('\n')
  const excerpt = summarizeDevtoolsCliRaw(raw, { maxLines: 8 })
  assert.match(excerpt, /\[error\] errcode=41002/)
  assert.match(excerpt, /Using AppID: wx123/)
  assert.match(excerpt, /start cli server error/)
  assert.ok(excerpt.split(/\r?\n/u).length <= 10)
})

test('formatAutomationCliError adds actionable hint for devtools port restart requirement', () => {
  const error = formatAutomationCliError(
    'IDE server has started on http://127.0.0.1:39085 and must be restarted on port 39100 first',
  )

  assert.match(error.message, /需要先把当前 DevTools HTTP 服务从 39085 重启到 39100/i)
  assert.match(error.message, /close 当前 session 或在微信开发者工具里重启服务端口/i)
})

test('formatAutomationCliError explains IDE initialize timeout with existing IDE port', () => {
  const error = formatAutomationCliError([
    '- initialize',
    'IDE may already started at port 56305, trying to connect',
    '#initialize-error: wait IDE port timeout',
  ].join('\n'))

  assert.match(error.message, /检测到已有 DevTools IDE 实例.*56305/i)
  assert.match(error.message, /attach 超时|连接超时/i)
  assert.match(error.message, /完全关闭微信开发者工具|重试 open/i)
})

test('formatAutomationCliError explains DevTools builder crash more clearly', () => {
  const error = formatAutomationCliError([
    'TypeError: Cannot read properties of undefined (reading \'MinTabbarCount\')',
    'at checkTabbar (F:/tools/wechat-devtools/code/package.nw/js/common/miniprogram-builder/modules/corecompiler/original/json/app/checkAppFields.js:2:2477)',
    'TypeError: Cannot read property \'getPreCompileOptions\' of undefined',
  ].join('\n'))

  assert.match(error.message, /DevTools.*编译阶段失败|builder/i)
  assert.match(error.message, /tabBar|custom tabBar|checkTabbar/i)
  assert.match(error.message, /不是普通.*session.*port|不是普通.*端口/i)
})

test('parseAutomationCliFailure treats DevTools code 17 output as fatal even with zero exit', () => {
  const failure = parseAutomationCliFailure({
    status: 0,
    raw: [
      '× preparing',
      '[error] code: 17',
      '二维码输出路径无效或不存在',
      'QR_PATH_NOT_VALID_OR_NOT_EXIST',
    ].join('\n'),
  }, {
    projectPath: '\\\\wsl.localhost\\ubuntu-22.04\\home\\wang\\demo\\apps\\miniprogram',
  })

  assert.ok(failure)
  assert.match(failure.message, /code 17|二维码输出路径|WSL UNC|--devtools-project/i)
  assert.match(failure.raw, /QR_PATH_NOT_VALID_OR_NOT_EXIST/)
})

test('validateAutomationCliConfig rejects missing and invalid CLI paths clearly', () => {
  assert.throws(
    () => validateAutomationCliConfig({ cliPath: '' }),
    /WECHAT_DEVTOOLS_CLI|--cli-path|DevTools CLI/i,
  )

  assert.throws(
    () => validateAutomationCliConfig({ cliPath: '/tmp/not-a-devtools-cli' }),
    /not found|不存在|DevTools CLI/i,
  )
})

test('enableAutomation pre-opens the project and reuses the resolved DevTools port for auto', {
  skip: process.platform === 'win32' ? 'POSIX direct-CLI wrapper is covered by macOS/Linux runners' : false,
}, () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-fake-devtools-cli-'))
  const callsPath = path.join(tempDir, 'calls.log')
  const fakeCliPath = path.join(tempDir, 'cli')
  fs.writeFileSync(fakeCliPath, [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> ${JSON.stringify(callsPath)}`,
    'if [ "$1" = "open" ]; then',
    '  echo "✔ IDE server has started, listening on http://127.0.0.1:38596"',
    '  exit 0',
    'fi',
    'echo "✔ IDE server has started, listening on http://127.0.0.1:38596"',
    'echo "[info] ws connect 38539 abc def"',
  ].join('\n'))
  fs.chmodSync(fakeCliPath, 0o755)

  const config = {
    cliPath: fakeCliPath,
    projectPath: '/mnt/f/demo/apps/miniprogram',
    autoPort: '9421',
    devtoolsPort: '',
  }

  const result = enableAutomation(config, { openFirst: true, runtime: 'darwin' })
  const calls = fs.readFileSync(callsPath, 'utf8').trim().split(/\r?\n/u)

  assert.equal(result.projectOpened, true)
  assert.equal(result.cliTimedOut, false)
  assert.equal(result.resolvedDevtoolsPort, '38596')
  assert.ok(!Object.prototype.hasOwnProperty.call(result, 'resolvedAutoPort'))
  assert.ok(!Object.prototype.hasOwnProperty.call(result, 'requestedAutoPort'))
  assert.ok(!Object.prototype.hasOwnProperty.call(result, 'autoPortOverrodeRequest'))
  assert.equal(config.devtoolsPort, '38596')
  assert.equal(config.autoPort, '9421')
  assert.ok(!Object.prototype.hasOwnProperty.call(config, 'autoPortSource'))
  assert.equal(calls.length, 2)
  assert.match(calls[0], /^open --project /u)
  assert.doesNotMatch(calls[0], /--debug/u)
  assert.doesNotMatch(calls[0], /--port/u)
  assert.match(calls[1], /^auto --project /u)
})

test('enableAutomation skips open by default and runs auto directly', {
  skip: process.platform === 'win32' ? 'POSIX direct-CLI wrapper is covered by macOS/Linux runners' : false,
}, () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-fake-devtools-cli-'))
  const callsPath = path.join(tempDir, 'calls.log')
  const fakeCliPath = path.join(tempDir, 'cli')
  fs.writeFileSync(fakeCliPath, [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> ${JSON.stringify(callsPath)}`,
    'echo "✔ IDE server has started, listening on http://127.0.0.1:38597"',
    'echo "[info] ws connect 38539 abc def"',
  ].join('\n'))
  fs.chmodSync(fakeCliPath, 0o755)

  const config = {
    cliPath: fakeCliPath,
    projectPath: '/mnt/f/demo/apps/miniprogram',
    autoPort: '9421',
    devtoolsPort: '',
  }

  const result = enableAutomation(config, { runtime: 'darwin' })
  const calls = fs.readFileSync(callsPath, 'utf8').trim().split(/\r?\n/u)

  assert.equal(result.projectOpened, false)
  assert.equal(result.cliTimedOut, false)
  assert.equal(result.resolvedDevtoolsPort, '38597')
  assert.equal(config.devtoolsPort, '38597')
  assert.equal(calls.length, 1)
  assert.match(calls[0], /^auto --project /u)
})

test('enableAutomation runs Windows DevTools bundle from the bundle directory', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-fake-devtools-bundle-'))
  const cwdPath = path.join(tempDir, 'cwd.log')
  const cliBatPath = path.join(tempDir, 'cli.bat')
  const cliJsPath = path.join(tempDir, 'cli.js')
  const nodeExePath = path.join(tempDir, 'node.exe')
  fs.writeFileSync(cliBatPath, '')
  fs.writeFileSync(cliJsPath, `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(cwdPath)}, process.cwd());
process.stdout.write('✔ IDE server has started, listening on http://127.0.0.1:38596\\n');
if (process.argv[2] !== 'open') process.stdout.write('[info] ws connect 38539 abc def\\n');
`)
  if (process.platform === 'win32') {
    try {
      fs.linkSync(process.execPath, nodeExePath)
    } catch (_) {
      fs.copyFileSync(process.execPath, nodeExePath)
    }
  } else {
    fs.writeFileSync(nodeExePath, `#!/bin/sh
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
shift
exec ${JSON.stringify(process.execPath)} "$DIR/cli.js" "$@"
`)
    fs.chmodSync(nodeExePath, 0o755)
  }

  enableAutomation({
    cliPath: cliBatPath,
    projectPath: '/mnt/f/demo/apps/miniprogram',
    autoPort: '9421',
    devtoolsPort: '',
  }, {
    runtime: 'linux',
    readProcVersion: '5.15.0-microsoft-standard-WSL2',
    toWindowsPath(inputPath) {
      if (/[\\/]cli\.js$/u.test(inputPath)) {
        return process.platform === 'win32' ? cliJsPath : 'F:\\tools\\wechat-devtools\\cli.js'
      }
      return 'F:\\demo\\apps\\miniprogram'
    },
  })

  assert.equal(fs.readFileSync(cwdPath, 'utf8').trim(), fs.realpathSync(tempDir))
})

test('detectAutomationCliProgressTimeout recognizes timed out auto startup after visible progress', () => {
  const result = detectAutomationCliProgressTimeout({
    error: new Error('spawnSync /fake/cli ETIMEDOUT'),
    raw: [
      '✔ IDE server has started, listening on http://127.0.0.1:38596',
      '[info] long connection established',
      '√ Using AppID: wx123',
    ].join('\n'),
  })

  assert.deepEqual(result, {
    message: 'spawnSync /fake/cli ETIMEDOUT',
    raw: [
      '✔ IDE server has started, listening on http://127.0.0.1:38596',
      '[info] long connection established',
      '√ Using AppID: wx123',
    ].join('\n'),
  })
})

test('closeDevtoolsProject closes the recorded DevTools project path', {
  skip: process.platform === 'win32' ? 'POSIX direct-CLI wrapper is covered by macOS/Linux runners' : false,
}, () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-fake-close-cli-'))
  const callsPath = path.join(tempDir, 'calls.log')
  const fakeCliPath = path.join(tempDir, 'cli')
  fs.writeFileSync(fakeCliPath, [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> ${JSON.stringify(callsPath)}`,
    'echo "✔ close"',
  ].join('\n'))
  fs.chmodSync(fakeCliPath, 0o755)

  const result = closeDevtoolsProject({
    cliPath: fakeCliPath,
    projectPath: '/tmp/source-project',
    devtoolsProjectPath: 'C:\\Users\\tester\\AppData\\Local\\Temp\\miniprogram-browser\\project-abc123def456',
    devtoolsPort: '24880',
  }, { runtime: 'darwin' })

  assert.equal(result.ok, true)
  assert.equal(result.attempted, true)
  const calls = fs.readFileSync(callsPath, 'utf8').trim().split(/\r?\n/u)
  assert.equal(calls.length, 1)
  assert.match(calls[0], /^close --project /u)
  assert.match(calls[0], /project-abc123def456/u)
  assert.match(calls[0], /--port 24880/u)
})

test('connectOrEnable runs enable before connect', async () => {
  const calls = []
  const result = await connectOrEnable({ autoPort: 9421 }, {
    allowEnable: true,
    forceEnable: true,
    onProgress(phase) {
      calls.push(`progress:${phase}`)
    },
  }, {
    async connect() {
      calls.push('connect')
      return { ok: true, async send() { return {} } }
    },
    enable() {
      calls.push('enable')
    },
    async isLive() {
      return true
    },
    async sleepFn(ms) {
      calls.push(`sleep:${ms}`)
    },
  })

  assert.deepEqual(calls, [
    'progress:enable',
    'enable',
    'progress:wait-live',
    'progress:connect',
    'connect',
  ])
  assert.ok(result.ok)
})

test('connectOrEnable passes its remaining timeout budget to enableAutomation', async () => {
  let enableOptions = null
  const result = await connectOrEnable({ autoPort: 9421 }, {
    allowEnable: true,
    forceEnable: true,
    timeoutMs: 250,
    minWaitMs: 0,
  }, {
    async connect() {
      return {
        ok: true,
        async send() { return {} },
      }
    },
    enable(_config, options) {
      enableOptions = options
      return {}
    },
    async isLive() { return true },
    async sleepFn() {},
  })

  assert.ok(result.ok)
  assert.ok(enableOptions)
  assert.equal(enableOptions.openFirst, false)
  assert.ok(enableOptions.timeoutMs > 0 && enableOptions.timeoutMs <= 250, enableOptions)
})

test('connectOrEnable waits for automation live after enable before connect', async () => {
  const calls = []
  let liveChecks = 0
  const result = await connectOrEnable({ autoPort: 9421 }, {
    allowEnable: true,
    forceEnable: true,
    connectTimeoutMs: 5000,
    onProgress(phase) {
      calls.push(`progress:${phase}`)
    },
  }, {
    async connect() {
      calls.push('connect')
      return { ok: true, async send() { return {} } }
    },
    enable() {
      calls.push('enable')
    },
    async isLive() {
      liveChecks += 1
      calls.push(`live:${liveChecks}`)
      return liveChecks >= 2
    },
    async sleepFn(ms) {
      calls.push(`sleep:${ms}`)
    },
  })

  assert.ok(result.ok)
  assert.ok(calls.includes('progress:enable'))
  assert.ok(calls.includes('progress:wait-live'))
  assert.ok(calls.includes('live:2'))
  assert.ok(calls.indexOf('connect') > calls.indexOf('live:2'))
})

test('discoverLiveAutomationPort finds first live port in range', async () => {
  const { discoverLiveAutomationPort } = require('../dist/lib/runtime-connect.js')
  const probed = []
  const port = await discoverLiveAutomationPort({ autoPort: '9517' }, {
    rangeStart: 9515,
    rangeEnd: 9540,
    maxProbes: 30,
    skipTcp: true,
    async isLive(cfg) {
      const p = String(cfg.autoPort || '')
      probed.push(p)
      return p === '9533'
    },
  })
  assert.equal(port, '9533')
  assert.ok(probed.includes('9517'))
  assert.ok(probed.includes('9533'))
})

test('connectOrEnable discovers alternate live port when preferred autoPort never becomes live', async () => {
  const calls = []
  const config = { autoPort: '9517' }
  // 直接测 discover 路径：wait-live 立即失败（无 min wait），再扫 port
  const result = await connectOrEnable(config, {
    allowEnable: true,
    forceEnable: true,
    connectTimeoutMs: 12000,
    minWaitMs: 0,
    onProgress(phase) {
      calls.push(`progress:${phase}`)
    },
  }, {
    async connect(cfg) {
      calls.push(`connect:${cfg.autoPort}`)
      return { ok: true, port: cfg.autoPort, async send() { return {} } }
    },
    enable() {
      calls.push('enable')
      return {}
    },
    async isLive(cfg) {
      const port = String(cfg.autoPort || '')
      calls.push(`live:${port}`)
      return port === '9533'
    },
    // 跳过 minWait 的真实等待
    async sleepFn() {},
  })

  assert.ok(result.ok, `calls=${calls.join(',')}`)
  assert.equal(String(config.autoPort), '9533')
  assert.ok(calls.includes('progress:discover-port'), `calls=${calls.join(',')}`)
  assert.ok(calls.includes('connect:9533'))
})

test('connectOrEnable proceeds when port becomes live on final check after wait budget', async () => {
  const calls = []
  let liveChecks = 0
  const result = await connectOrEnable({ autoPort: 9421 }, {
    allowEnable: true,
    forceEnable: true,
    connectTimeoutMs: 50,
    onProgress(phase) { calls.push(phase) },
  }, {
    enable() { calls.push('enable') },
    async isLive() {
      liveChecks += 1
      calls.push(`live:${liveChecks}`)
      // 预算内一直 false，最终 late check 才 true
      return liveChecks >= 3
    },
    async connect() {
      calls.push('connect')
      return { ok: true, async send() { return {} } }
    },
    async sleepFn() {},
  })
  assert.ok(result.ok)
  assert.ok(calls.includes('enable'))
  assert.ok(calls.includes('connect'))
  assert.ok(liveChecks >= 2)
})

test('connectOrEnable refuses enable when allowEnable is false and endpoint is not live', async () => {
  await assert.rejects(
    connectOrEnable({ autoPort: 9421, projectPath: '/repo/apps/miniprogram' }, {
      allowEnable: false,
    }, {
      async connect() {
        throw new Error('should not connect')
      },
      enable() {
        throw new Error('should not enable')
      },
      async sleepFn() {},
      async isLive() {
        return false
      },
    }),
    /自动化未连接|请先 open/i,
  )
})

test('connectOrEnable adopts resolved devtools port from enable metadata', async () => {
  const config = { autoPort: 9421, devtoolsPort: '' }
  let observedPort = ''
  await connectOrEnable(config, { allowEnable: true, forceEnable: true }, {
    async connect(nextConfig) {
      observedPort = nextConfig.devtoolsPort
      return { ok: true, async send() { return {} } }
    },
    async isLive() { return true },
    enable() {
      return { resolvedDevtoolsPort: '38596' }
    },
    async sleepFn() {},
  })

  assert.equal(config.devtoolsPort, '38596')
  assert.equal(observedPort, '38596')
})

test('connectWithRetry rejects with timeout on hanging connect', async () => {
  const result = await connectWithRetry({ autoPort: 9421 }, {
    maxAttempts: 1,
    attemptTimeoutMs: 50,
    sleepFn: async () => {},
    automator: {
      launcher: {
        async connectTool() {
          return new Promise(() => {})
        },
      },
    },
  }).then(
    () => ({ ok: true }),
    (error) => ({ ok: false, message: error.message }),
  )

  assert.equal(result.ok, false)
  assert.match(result.message, /connectTool timeout/i)
})

test('connectOrEnable passes deadlineAt to connect', async () => {
  let observedOptions = null
  const result = await connectOrEnable({ autoPort: 9421 }, { allowEnable: true, forceEnable: true }, {
    async connect(_config, connectOptions) {
      observedOptions = connectOptions
      return { ok: true, async send() { return {} } }
    },
    async isLive() { return true },
    enable() {
      return {}
    },
    async sleepFn() {},
  })

  assert.ok(result.ok)
  assert.ok(observedOptions)
  assert.ok(typeof observedOptions.deadlineAt === 'number')
})

test('connectWithRetry bounds a hanging automation connect attempt', async () => {
  const pending = connectWithRetry({ autoPort: 9421 }, {
    maxAttempts: 1,
    attemptTimeoutMs: 50,
    sleepFn: async () => {},
    automator: {
      connect() {
        return new Promise(() => {})
      },
    },
  }).then(
    () => ({ ok: true }),
    (error) => ({ ok: false, error }),
  )

  const result = await Promise.race([
    pending,
    new Promise((resolve) => setTimeout(() => resolve({ pending: true }), 250)),
  ])

  assert.notEqual(result.pending, true)
  assert.equal(result.ok, false)
  assert.match(result.error.message, /connectTool timeout/i)
})

test('connectOrEnable runs enable and connect, failure bubbles up', async () => {
  const calls = []
  await assert.rejects(
    connectOrEnable({ autoPort: 9421 }, {
    allowEnable: true,
    forceEnable: true,
      onProgress(phase) {
        calls.push(`progress:${phase}`)
      },
    }, {
      async connect() {
        calls.push('connect')
        throw new Error('Failed connecting to ws://127.0.0.1:9421')
      },
      async isLive() { return true },
      enable() {
        calls.push('enable')
      },
      async sleepFn(ms) {
        calls.push(`sleep:${ms}`)
      },
    }),
    /Failed connecting/,
  )

  assert.deepEqual(calls, [
    'progress:enable',
    'enable',
    'progress:wait-live',
    'progress:connect',
    'connect',
  ])
})

test('connectOrEnable always runs enable first; builder issue surfaces when ws connect fails', async () => {
  await assert.rejects(
    connectOrEnable({ autoPort: 9421 }, { allowEnable: true, forceEnable: true }, {
      async connect() {
        throw new Error('Failed connecting to ws://127.0.0.1:9421')
      },
      async isLive() { return true },
      enable() {
        return {
          startupIssue: {
            message: 'DevTools 已启动，但当前项目在编译阶段失败（builder/checkTabbar）；这不是普通 session/port 冲突。',
            raw: 'TypeError: Cannot read properties of undefined (reading \'MinTabbarCount\')',
          },
        }
      },
      async sleepFn() {},
    }),
    /编译阶段失败|checkTabbar|不是普通.*port/i,
  )
})

test('connectOrEnable surfaces builder issue when ws connect still fails after enable', async () => {
  await assert.rejects(
    connectOrEnable({ autoPort: 9421 }, { allowEnable: true, forceEnable: true }, {
      async connect() {
        throw new Error('Failed connecting to ws://127.0.0.1:9421')
      },
      async isLive() { return true },
      enable() {
        return {
          startupIssue: {
            message: 'DevTools 已启动，但当前项目在编译阶段失败（builder/checkTabbar）；这不是普通 session/port 冲突。',
            raw: 'TypeError: Cannot read properties of undefined (reading \'MinTabbarCount\')',
          },
        }
      },
      async sleepFn() {},
    }),
    /编译阶段失败|checkTabbar|不是普通.*port/i,
  )
})

test('buildAutomationArgs omits HTTP port when devtoolsPort is empty', () => {
  const result = buildAutomationArgs({
    cliPath: '/mnt/f/tools/wechat-devtools/cli.bat',
    projectPath: '/mnt/f/demo/apps/miniprogram',
    autoPort: '9421',
    devtoolsPort: '',
  }, WSL_TEST_OPTIONS)

  assert.deepEqual(result.args.slice(0, 2), ['auto', '--project'])
  assert.equal(result.args[2], 'F:\\demo\\apps\\miniprogram')
  assert.equal(result.args.includes('--port'), false)
  assert.equal(result.args.includes('--debug'), true)
  assert.deepEqual(result.args.slice(3, 5), ['--auto-port', '9421'])
})

test('buildAutomationArgs includes explicit HTTP port when provided', () => {
  const result = buildAutomationArgs({
    cliPath: '/mnt/f/tools/wechat-devtools/cli.bat',
    projectPath: '/mnt/f/demo/apps/miniprogram',
    autoPort: '9421',
    devtoolsPort: '39085',
  }, WSL_TEST_OPTIONS)

  assert.deepEqual(result.args.slice(3), ['--auto-port', '9421', '--port', '39085', '--debug'])
})

test('buildAutomationArgs includes trust-project when enabled', () => {
  const result = buildAutomationArgs({
    cliPath: '/mnt/f/tools/wechat-devtools/cli.bat',
    projectPath: '/mnt/f/demo/apps/miniprogram',
    autoPort: '9421',
    devtoolsPort: '',
    trustProject: true,
  }, WSL_TEST_OPTIONS)

  assert.equal(result.args.includes('--trust-project'), true)
})

test('buildAutomationArgs prefers explicit devtoolsProjectPath for Windows CLI bundles', () => {
  const result = buildAutomationArgs({
    cliPath: '/mnt/f/tools/wechat-devtools/cli.bat',
    projectPath: '/home/developer/work/sample-app/apps/miniprogram',
    devtoolsProjectPath: 'P:\\demo\\apps\\miniprogram',
    autoPort: '9421',
    devtoolsPort: '',
  }, {
    ...WSL_TEST_OPTIONS,
    toWindowsPath() {
      throw new Error('local project path should not be converted when devtoolsProjectPath is set')
    },
  })

  assert.equal(result.args[2], 'P:\\demo\\apps\\miniprogram')
})

test('buildAutomationArgs applies explicit project prefix map before WSL conversion', () => {
  const result = buildAutomationArgs({
    cliPath: '/mnt/f/tools/wechat-devtools/cli.bat',
    projectPath: '/home/developer/workspace/sample-suite/sample-app/apps/miniprogram',
    devtoolsProjectMap: '/home/developer/workspace=P:\\workspace',
    autoPort: '9421',
    devtoolsPort: '',
  }, {
    ...WSL_TEST_OPTIONS,
    toWindowsPath() {
      throw new Error('mapped project path should not fall back to wslpath conversion')
    },
  })

  assert.equal(result.args[2], 'P:\\workspace\\sample-suite\\sample-app\\apps\\miniprogram')
})

test('buildAutomationArgs uses the longest matching project prefix map', () => {
  const result = buildAutomationArgs({
    cliPath: '/mnt/f/tools/wechat-devtools/cli.bat',
    projectPath: '/home/developer/workspace/sample-suite/sample-app/apps/miniprogram',
    devtoolsProjectMap: '/home/developer=P:\\broad;/home/developer/workspace/sample-suite=Q:\\suite',
    autoPort: '9421',
    devtoolsPort: '',
  }, WSL_TEST_OPTIONS)

  assert.equal(result.args[2], 'Q:\\suite\\sample-app\\apps\\miniprogram')
})

test('buildAutomationArgs rejects malformed project prefix maps clearly', () => {
  assert.throws(
    () => buildAutomationArgs({
      cliPath: '/mnt/f/tools/wechat-devtools/cli.bat',
      projectPath: '/home/developer/work/sample-app/apps/miniprogram',
      devtoolsProjectMap: '/home/developer/work',
      autoPort: '9421',
      devtoolsPort: '',
    }, WSL_TEST_OPTIONS),
    /project map|linux=windows|WECHAT_DEVTOOLS_PROJECT_MAP/i,
  )
})

test('buildAutomationArgs allows deterministic WSL mount conversion injection', () => {
  const result = buildAutomationArgs({
    cliPath: '/mnt/f/tools/wechat-devtools/cli.bat',
    projectPath: '/mnt/z/work/apps/miniprogram',
    autoPort: '9421',
    devtoolsPort: '',
  }, {
    ...WSL_TEST_OPTIONS,
    toWindowsPath(inputPath) {
      assert.equal(inputPath, '/mnt/z/work/apps/miniprogram')
      return 'Z:\\work\\apps\\miniprogram'
    },
  })

  assert.equal(result.args[2], 'Z:\\work\\apps\\miniprogram')
})

test('normalizeAwaitCondition supports built-in and prefixed await conditions', () => {
  assert.deepEqual(normalizeAwaitCondition('stable'), {
    kind: 'stable',
    value: '',
    raw: 'stable',
  })
  assert.deepEqual(normalizeAwaitCondition('app-ready'), {
    kind: 'app-ready',
    value: '',
    raw: 'app-ready',
  })
  assert.deepEqual(normalizeAwaitCondition('route:/pages/profile/index'), {
    kind: 'route',
    value: 'pages/profile/index',
    raw: 'route:/pages/profile/index',
  })
  assert.deepEqual(normalizeAwaitCondition('selector:.submit-btn'), {
    kind: 'selector',
    value: '.submit-btn',
    raw: 'selector:.submit-btn',
  })
})

test('resolveAwaitTimeoutMs keeps long app-ready defaults and shorter route defaults', () => {
  assert.equal(resolveAwaitTimeoutMs(normalizeAwaitCondition('app-ready')), 90000)
  assert.equal(resolveAwaitTimeoutMs(normalizeAwaitCondition('stable')), 15000)
  assert.equal(resolveAwaitTimeoutMs(normalizeAwaitCondition('route:/pages/index/index')), 8000)
  assert.equal(resolveAwaitTimeoutMs(normalizeAwaitCondition('selector:.submit-btn')), 12000)
  assert.equal(resolveAwaitTimeoutMs(normalizeAwaitCondition('selector:.submit-btn'), 3456), 3456)
})

test('waitForMiniProgramStable resolves after route and page stack stay quiet', async () => {
  const page = createInteractivePage(['Ready'])
  page.path = 'pages/index/index'
  let currentPageCalls = 0
  const miniProgram = {
    async currentPage() {
      currentPageCalls += 1
      return page
    },
    async pageStack() {
      return [{ path: 'pages/index/index', query: {} }]
    },
  }

  const result = await waitForMiniProgramStable(miniProgram, {
    quietMs: 0,
    timeoutMs: 200,
    pollMs: 1,
    sleepFn: async () => {},
  })

  assert.equal(result.ok, true)
  assert.equal(result.path, 'pages/index/index')
  assert.equal(result.pageStackDepth, 1)
  assert.equal(result.viewReady, true)
  assert.ok(result.viewNodeCount > 0)
  assert.ok(currentPageCalls >= 1)
})

test('waitForMiniProgramStable marks timeout as non-atomic when runtime keeps changing', async () => {
  const paths = ['pages/loading/index', 'pages/bootstrap/index', 'pages/loading/index', 'pages/bootstrap/index']
  const miniProgram = {
    async currentPage() {
      return {
        path: paths.shift() || 'pages/bootstrap/index',
        async $$() {
          return []
        },
      }
    },
    async pageStack() {
      return [{ path: paths[0] || 'pages/bootstrap/index', query: {} }]
    },
  }

  await assert.rejects(
    () => waitForMiniProgramStable(miniProgram, {
      quietMs: 50,
      timeoutMs: 20,
      pollMs: 1,
    }),
    (error) => {
      assert.equal(error.code, 'RUNTIME_UNSTABLE')
      assert.equal(error.runtimeMayContinue, true)
      assert.match(error.hint, /phase=stable/i)
      return true
    },
  )
})

test('waitForMiniProgramCondition resolves route targets after polling', async () => {
  const seenPaths = ['pages/index/index', 'pages/profile/loading', 'pages/profile/index', 'pages/profile/index']
  const miniProgram = {
    async currentPage() {
      const pathValue = seenPaths.shift() || 'pages/profile/index'
      return {
        path: pathValue,
        async $$() {
          return []
        },
      }
    },
  }

  const result = await waitForMiniProgramCondition(miniProgram, createState(), normalizeAwaitCondition('route:/pages/profile/index'), {
    timeoutMs: 200,
    pollMs: 1,
    sleepFn: async () => {},
  })

  assert.equal(result.ok, true)
  assert.equal(result.condition.kind, 'route')
  assert.equal(result.path, 'pages/profile/index')
})

test('waitForMiniProgramCondition resolves an existing ref through runtime-resolve', async () => {
  const button = { tagName: 'button' }
  const page = {
    path: 'pages/index/index',
    async $$(selector) { return selector === 'button' ? [button] : [] },
  }
  const state = createState()
  state.refs['@e1'] = {
    ref: '@e1',
    route: page.path,
    kind: 'button',
    strategy: { kind: 'selector', selector: 'button', index: 0 },
  }
  const miniProgram = {
    async currentPage() { return page },
  }

  const result = await waitForMiniProgramCondition(
    miniProgram,
    state,
    normalizeAwaitCondition('ref:@e1'),
    { timeout: 20, pollMs: 1 },
  )

  assert.equal(result.ok, true)
  assert.equal(result.path, page.path)
})

test('waitForMiniProgramCondition times out hidden checks with a short fact-style summary', async () => {
  const miniProgram = {
    async currentPage() {
      return {
        path: 'pages/index/index',
        async $$(selector) {
          if (selector === '.still-visible') {
            return [{
              async size() {
                return { width: 20, height: 10 }
              },
            }]
          }
          return []
        },
      }
    },
  }

  await assert.rejects(
    waitForMiniProgramCondition(miniProgram, createState(), normalizeAwaitCondition('hidden:.still-visible'), {
      timeoutMs: 5,
      pollMs: 1,
      sleepFn: async () => {},
    }),
    (error) => {
      assert.equal(error.code, 'AWAIT_TIMEOUT')
      assert.match(error.message, /hidden:\.still-visible/)
      assert.match(error.hint, /kind=hidden|matches=1/i)
      return true
    },
  )
})

test('extractLogSummary returns one compact log line without hardcoded diagnosis text', () => {
  const summary = extractLogSummary({
    files: [
      {
        lines: [
          '',
          '[2026-05-02 19:44:23.107][ERROR][unknow] routeTo appLaunch timeout',
          '[2026-05-02 19:44:26.700][ERROR][unknow] !!! triggerAppRouteDone timeout {',
        ],
      },
    ],
  })

  assert.equal(summary, '[2026-05-02 19:44:23.107][ERROR][unknow] routeTo appLaunch timeout')
})

test('extractLogSummary prefers automation startup facts over earlier generic errors', () => {
  const summary = extractLogSummary({
    files: [
      {
        lines: [
          '[2026-05-02 19:44:20.100][ERROR][unknow] errcode=41002 appid missing',
          '[2026-05-02 19:44:23.107][ERROR][unknow] routeTo appLaunch timeout',
          '[2026-05-02 19:44:24.200][ERROR][unknow] start cli server error: [object Object]',
        ],
      },
    ],
  })

  assert.equal(summary, '[2026-05-02 19:44:24.200][ERROR][unknow] start cli server error: [object Object]')
})

test('extractLogSummary prefers simulator compile crashes over secondary cli server errors', () => {
  const summary = extractLogSummary({
    files: [
      {
        lines: [
          '[2026-05-02 22:19:47.675][ERROR][unknow] fetchDevelopLibInfo Error: appid missing',
          "[2026-05-02 22:19:47.722][ERROR][unknow] simulator launch catch error TypeError: Cannot read properties of undefined (reading 'MinTabbarCount')",
          '[2026-05-02 22:19:47.887][ERROR][unknow] start cli server error: [object Object]',
        ],
      },
    ],
  })

  assert.match(summary, /simulator launch catch error.*MinTabbarCount/)
})

test('extractLogSummary does not prefer stale high-priority facts over the latest log file', () => {
  const summary = extractLogSummary({
    files: [
      {
        path: 'latest.log',
        lines: [
          '[2026-05-02 22:15:08.601][ERROR][unknow] appid missing',
          '[2026-05-02 22:15:19.257][ERROR][unknow] routeTo appLaunch timeout',
        ],
      },
      {
        path: 'older.log',
        lines: [
          '[2026-05-02 22:12:48.033][ERROR][unknow] start cli server error: [object Object]',
        ],
      },
    ],
  })

  assert.equal(summary, '[2026-05-02 22:15:19.257][ERROR][unknow] routeTo appLaunch timeout')
})

test('sendAutomationProtocol exposes raw automation protocol results', async () => {
  const result = await sendAutomationProtocol({ autoPort: '9489' }, 'Tool.getInfo', {}, {
    timeoutMs: 20,
    automator: {
      launcher: {
        async connectTool() {
          return {
            async send(method) {
              assert.equal(method, 'Tool.getInfo')
              return { version: '2.01.2510290' }
            },
            disconnect() {},
          }
        },
      },
    },
  })

  assert.equal(result.endpoint, 'ws://127.0.0.1:9489')
  assert.equal(result.ok, true)
  assert.deepEqual(result.result, { version: '2.01.2510290' })
})

test('connectWithRetry with maxAttempts fails after all attempts', async () => {
  let attempts = 0
  await assert.rejects(
    connectWithRetry({ autoPort: '9498' }, {
      maxAttempts: 2,
      attemptTimeoutMs: 200,
      sleepFn: async () => {},
      automator: {
        launcher: {
          async connectTool() {
            attempts += 1
            throw new Error('connection refused')
          },
        },
      },
    }),
    /connection refused/i,
  )

  assert.equal(attempts, 2)
})

test('connectWithRetry returns connected miniProgram', async () => {
  let attempts = 0
  let disconnected = false

  const miniProgram = await connectWithRetry({ autoPort: '9499' }, {
    maxAttempts: 10,
    attemptTimeoutMs: 2000,
    sleepFn: async () => {},
    automator: {
      launcher: {
        async connectTool() {
          attempts += 1
          return {
            async send(method) {
              if (method === 'Tool.getInfo') {
                return { version: '2.01.2510290' }
              }
              return new Promise(() => {})
            },
            async disconnect() {
              disconnected = true
            },
          }
        },
      },
    },
  })

  assert.equal(attempts, 1)
  await cleanupMiniProgram(miniProgram)
  assert.equal(disconnected, true)
})

test('withMiniProgram forwards allowRuntimeNotReady to the runtime connection layer', async () => {
  const observed = {}
  let evaluateCalled = false
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-with-mini-'))
  const state = {
    epoch: 0,
    nextRefIndex: 1,
    refs: {},
    route: '',
    config: {
      projectPath: '/repo/apps/miniprogram',
      screenshotDir: path.join(tempRoot, 'shots'),
      tempScreenshotDir: path.join(tempRoot, 'tmp-shots'),
    },
    portResolution: {
      autoPortAssigned: true,
    },
  }

  const miniProgram = {
    __mpbRuntimeReady: false,
    on() {},
    removeListener() {},
    disconnect() {},
    async evaluate() {
      evaluateCalled = true
      throw new Error('route monitor should be skipped while app runtime is not ready')
    },
    async send(method) {
      if (method === 'Tool.getInfo') {
        return { version: '2.01.2510290', SDKVersion: '3.15.1' }
      }
      if (method === 'App.enableLog') {
        return {}
      }
      if (method === 'App.getPageStack') {
        return { pageStack: [] }
      }
      if (method === 'App.getCurrentPage') {
        return { pageId: 'page-1', path: 'pages/index/index', query: {} }
      }
      if (method === 'App.callWxMethod') {
        return { result: {} }
      }
      return {}
    },
  }

  try {
    const result = await withMiniProgram(state, async () => 'ok', {
      allowRuntimeNotReady: true,
      connectOrEnable: async (_config, options) => {
        observed.options = options
        return miniProgram
      },
    })

    assert.equal(result, 'ok')
    assert.equal(observed.options.allowRuntimeNotReady, true)
    assert.equal(evaluateCalled, false)
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('collectDevtoolsLogs discovers the active WeappLog root from launch.log', async () => {
  const userDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-user-data-'))
  const defaultHash = 'f0900000000000000000000000000000'
  const activeHash = 'c47e95d2ca97f7fdd1f0dc06a6544145'
  const activeLogRoot = path.join(userDataRoot, activeHash, 'WeappLog')
  fs.mkdirSync(activeLogRoot, { recursive: true })
  fs.mkdirSync(path.join(userDataRoot, defaultHash, 'WeappLog'), { recursive: true })
  fs.writeFileSync(path.join(activeLogRoot, 'launch.log'), 'launch from F:\\tools\\wechat-devtools\\cli.bat\n')
  fs.writeFileSync(path.join(activeLogRoot, 'stdout.log'), 'appid missing\nappservice reload\n')

  const payload = await collectDevtoolsLogs({
    cliPath: '/mnt/f/tools/wechat-devtools/cli.bat',
  }, {
    runtime: 'linux',
    readProcVersion: '5.15.0-microsoft-standard-WSL2',
    localAppData: 'C:\\Users\\tester\\AppData\\Local',
    files: 2,
    limit: 5,
    grep: 'appid|appservice',
    toWindowsPath(inputPath) {
      assert.equal(inputPath, '/mnt/f/tools/wechat-devtools')
      return 'F:\\tools\\wechat-devtools'
    },
    windowsPathToWslPath(inputPath) {
      const match = String(inputPath).match(/User Data\\([^\\]+)\\WeappLog$/u)
      assert.ok(match)
      return path.join(userDataRoot, match[1], 'WeappLog')
    },
  })

  assert.equal(payload.productHash, activeHash)
  assert.equal(payload.logRoot, activeLogRoot)
  assert.equal(payload.files.some((file) => file.lines.includes('appid missing')), true)
  assert.equal(payload.files.some((file) => file.lines.includes('appservice reload')), true)
})

test('collectDevtoolsLogs discovers the newest macOS WeappLog profile', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-mac-home-'))
  const userDataRoot = path.join(homeDir, 'Library', 'Application Support', '微信开发者工具')
  const oldRoot = path.join(userDataRoot, 'old-profile', 'WeappLog')
  const activeRoot = path.join(userDataRoot, 'active-profile', 'WeappLog')
  fs.mkdirSync(oldRoot, { recursive: true })
  fs.mkdirSync(activeRoot, { recursive: true })
  fs.writeFileSync(path.join(oldRoot, 'stdout.log'), 'old log\n')
  fs.writeFileSync(path.join(activeRoot, 'stdout.log'), 'active appservice log\n')
  const oldTime = new Date(Date.now() - 60_000)
  fs.utimesSync(path.join(oldRoot, 'stdout.log'), oldTime, oldTime)

  try {
    const payload = await collectDevtoolsLogs({
      cliPath: '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
    }, {
      runtime: 'darwin',
      homeDir,
      files: 1,
      limit: 5,
    })

    assert.equal(payload.productHash, 'active-profile')
    assert.equal(payload.logRoot, activeRoot)
    assert.equal(payload.files[0].lines.includes('active appservice log'), true)
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})
