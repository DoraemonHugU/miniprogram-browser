const test = require('node:test')
const assert = require('node:assert/strict')

const {
  buildSemanticSignature,
  buildGridLayout,
  buildVisualDiffSummary,
  createVisualProbe,
  collectRecordRects,
} = require('../scripts/lib/visual-change.cjs')

test('buildSemanticSignature is stable for same semantic records', () => {
  const records = [
    { kind: 'text', text: '常用工具' },
    { kind: 'button', text: '倒计时' },
  ]

  assert.equal(
    buildSemanticSignature(records),
    buildSemanticSignature([
      { kind: 'text', text: '常用工具' },
      { kind: 'button', text: '倒计时' },
    ]),
  )
})

test('buildGridLayout uses square cells from fixed column count', () => {
  assert.deepEqual(buildGridLayout(320, 640, 8), {
    width: 320,
    height: 640,
    columns: 8,
    rows: 16,
    cellSize: 40,
  })
})

test('buildVisualDiffSummary merges adjacent changed cells and maps refs', () => {
  const beforeProbe = {
    route: 'pages/dashboard/index',
    semanticSignature: 'same',
    layout: { width: 400, height: 800, columns: 4, rows: 8, cellSize: 100 },
    cells: [
      0, 0, 0, 0,
      0, 0, 0, 0,
      0, 0, 0, 0,
      0, 0, 0, 0,
      0, 0, 0, 0,
      0, 0, 0, 0,
      0, 0, 0, 0,
      0, 0, 0, 0,
    ],
    refs: [
      {
        ref: '@e44',
        kind: 'button',
        text: '+',
        rectPct: { x: 50, y: 37.5, w: 20, h: 12.5 },
      },
    ],
  }
  const afterProbe = {
    route: 'pages/dashboard/index',
    semanticSignature: 'same',
    layout: { width: 400, height: 800, columns: 4, rows: 8, cellSize: 100 },
    cells: [
      0, 0, 0, 0,
      0, 0, 0, 0,
      0, 0, 18, 18,
      0, 0, 18, 18,
      0, 0, 0, 0,
      0, 0, 0, 0,
      0, 0, 0, 0,
      0, 0, 0, 0,
    ],
    refs: [
      {
        ref: '@e44',
        kind: 'button',
        text: '+',
        rectPct: { x: 55, y: 38, w: 20, h: 12 },
      },
    ],
  }

  const summary = buildVisualDiffSummary(beforeProbe, afterProbe)
  assert.equal(summary.visualChanged, true)
  assert.deepEqual(summary.regions, [
    {
      regionPct: { x: 50, y: 25, w: 50, h: 25 },
      beforeRefs: [{ ref: '@e44', kind: 'button', text: '+' }],
      afterRefs: [{ ref: '@e44', kind: 'button', text: '+' }],
    },
  ])
})

test('buildVisualDiffSummary returns null when semantic signature already changed', () => {
  const result = buildVisualDiffSummary(
    { route: 'pages/dashboard/index', semanticSignature: 'before', layout: { width: 100, height: 100, columns: 1, rows: 1, cellSize: 100 }, cells: [0], refs: [] },
    { route: 'pages/dashboard/index', semanticSignature: 'after', layout: { width: 100, height: 100, columns: 1, rows: 1, cellSize: 100 }, cells: [20], refs: [] },
  )

  assert.equal(result, null)
})

test('createVisualProbe uses temp file screenshot instead of raw base64 capture', async () => {
  const screenshotCalls = []
  const probe = await createVisualProbe({
    miniProgram: {
      async screenshot(options) {
        screenshotCalls.push(options)
      },
      async systemInfo() {
        return { windowWidth: 320, windowHeight: 640 }
      },
    },
    page: {
      path: 'pages/dashboard/index',
    },
    records: [],
    config: {
      tempScreenshotDir: '/tmp',
    },
    captureScreenshot: async (miniProgram, targetPath) => {
      await miniProgram.screenshot({ path: targetPath })
      return targetPath
    },
    createImageAdapter: async () => ({
      bitmap: {
        width: 320,
        height: 640,
        data: Buffer.alloc(320 * 640 * 4),
      },
    }),
  })

  assert.equal(screenshotCalls.length, 1)
  assert.equal(typeof screenshotCalls[0].path, 'string')
  assert.equal(probe.layout.columns, 8)
})

test('createVisualProbe can reuse an already captured screenshot path', async () => {
  let called = false
  const probe = await createVisualProbe({
    miniProgram: {
      async systemInfo() {
        return { windowWidth: 320, windowHeight: 640 }
      },
    },
    page: { path: 'pages/dashboard/index' },
    records: [],
    config: { tempScreenshotDir: '/tmp' },
    screenshotPath: '/tmp/already-there.png',
    captureScreenshot: async () => { called = true },
    createImageAdapter: async () => ({
      bitmap: {
        width: 320,
        height: 640,
        data: Buffer.alloc(320 * 640 * 4),
      },
    }),
  })

  assert.equal(called, false)
  assert.equal(probe.route, 'pages/dashboard/index')
})

test('collectRecordRects maps selectors to percentage rects', async () => {
  const refs = await collectRecordRects({
    async $$(selector) {
      if (selector !== '.cta') return []
      return [{
        async size() { return { width: 100, height: 50 } },
        async offset() { return { left: 50, top: 25 } },
      }]
    },
  }, [
    { ref: '@e1', kind: 'button', text: '开始', strategy: { selector: '.cta', index: 0 } },
  ], {
    windowWidth: 200,
    windowHeight: 100,
  })

  assert.deepEqual(refs, [{
    ref: '@e1',
    businessKey: undefined,
    selector: '.cta',
    kind: 'button',
    text: '开始',
    rectPct: { x: 25, y: 25, w: 50, h: 50 },
  }])
})
