const test = require('node:test')
const assert = require('node:assert/strict')

const {
  captureVisualScreenshot,
  captureAnnotatedScreenshot,
  overlayFocusScreenshot,
  readOfficialMenuButtonRect,
  resolveCapsulePaintSpec,
  resolveNavigationMetrics,
  resolveCapsuleBox,
} = require('../scripts/lib/visual.cjs')

test('resolveNavigationMetrics matches project fallback behavior', () => {
  const result = resolveNavigationMetrics({
    statusBarHeight: 47,
    screenWidth: 390,
  })

  assert.deepEqual(result, {
    statusBarHeight: 47,
    navBarHeight: 95,
    navBarContentHeight: 48,
    contentTop: 111,
    capsuleWidth: 116,
    capsuleSlotWidth: 102,
  })
})

test('resolveNavigationMetrics uses menu button rect when available', () => {
  const result = resolveNavigationMetrics(
    {
      statusBarHeight: 47,
      screenWidth: 390,
    },
    {
      top: 53,
      right: 370,
      width: 96,
      height: 32,
      bottom: 85,
      left: 274,
    },
  )

  assert.equal(result.capsuleWidth, 136)
  assert.equal(result.capsuleSlotWidth, 116)
  assert.equal(result.navBarHeight, 91)
})

test('resolveCapsuleBox converts layout metrics into image pixels', () => {
  const box = resolveCapsuleBox({
    imageWidth: 1170,
    navigationMetrics: {
      statusBarHeight: 47,
      navBarHeight: 95,
      navBarContentHeight: 48,
      contentTop: 111,
      capsuleWidth: 116,
      capsuleSlotWidth: 102,
    },
    windowWidth: 390,
    pixelRatio: 3,
  })

  assert.deepEqual(box, {
    x: 822,
    y: 165,
    width: 264,
    height: 96,
    separatorX: 954,
    centerY: 213,
    scale: 3,
  })
})

test('resolveCapsulePaintSpec returns more realistic capsule geometry', () => {
  const spec = resolveCapsulePaintSpec({
    x: 822,
    y: 165,
    width: 264,
    height: 96,
    separatorX: 954,
    centerY: 213,
    scale: 3,
  })

  assert.deepEqual(spec, {
    shadowLayers: [
      { spread: 9, alpha: 26 },
      { spread: 3, alpha: 18 },
    ],
    borderThickness: 2,
    separatorInset: 24,
    dividerThickness: 1,
    menuDotRadius: 5,
    menuDotGap: 16,
    closeRingRadius: 10,
    closeRingStroke: 3,
  })
})

test('captureVisualScreenshot reuses provided page capture function', async () => {
  const calls = []
  const result = await captureVisualScreenshot({
    miniProgram: {
      async systemInfo() {
        return {
          pixelRatio: 3,
          statusBarHeight: 47,
          windowWidth: 390,
          screenWidth: 390,
        }
      },
      async callWxMethod() {
        return undefined
      },
    },
    targetPath: '/tmp/fake-shot.png',
    config: { repoRoot: '/repo' },
    pageCapture: async (targetPath) => {
      calls.push(targetPath)
      return targetPath
    },
    createImageAdapter: async () => ({
      bitmap: { width: 1170 },
      writeAsync: async () => {},
      scan: () => {},
    }),
    colorAdapter: {
      rgbaToInt: () => 0,
    },
  })

  assert.deepEqual(calls, ['/tmp/fake-shot.png'])
  assert.equal(result.path, '/tmp/fake-shot.png')
})

test('readOfficialMenuButtonRect prefers evaluate over slower callWxMethod', async () => {
  const rect = await readOfficialMenuButtonRect({
    callWxMethod: async () => new Promise((resolve) => setTimeout(() => resolve({ width: 88 }), 50)),
    evaluate: async () => ({ width: 87, height: 32, left: 296, top: 51, right: 383, bottom: 83 }),
  }, 20)

  assert.deepEqual(rect, { width: 87, height: 32, left: 296, top: 51, right: 383, bottom: 83 })
})

test('captureAnnotatedScreenshot overlays legend and returns annotate mode', async () => {
  const printed = []
  const pageCaptureCalls = []
  const result = await captureAnnotatedScreenshot({
    miniProgram: {},
    targetPath: '/tmp/annotate.png',
    config: { repoRoot: '/repo' },
    refs: [
      { ref: '@e1', kind: 'button', text: '开始', rectPct: { x: 10, y: 20, w: 20, h: 10 } },
    ],
    timeoutMs: 1234,
    pageCapture: async (targetPath, timeoutMs) => {
      pageCaptureCalls.push({ targetPath, timeoutMs })
      return targetPath
    },
    createImageAdapter: async () => ({
      bitmap: { width: 200, height: 100 },
      scan: () => {},
      composite: () => {},
      print: (...args) => { printed.push(args) },
      writeAsync: async () => {},
    }),
    colorAdapter: {
      rgbaToInt: () => 0,
      create: async () => ({
        bitmap: { width: 1, height: 1 },
        scan: () => {},
      }),
      loadFont: async () => ({}),
      FONT_SANS_16_WHITE: 'font',
    },
  })

  assert.equal(result.mode, 'annotate')
  assert.deepEqual(result.legend, ['@e1 [button] 开始'])
  assert.deepEqual(pageCaptureCalls, [{ targetPath: '/tmp/annotate.png', timeoutMs: 1234 }])
  assert.equal(printed.length > 0, true)
})

test('overlayFocusScreenshot highlights multiple refs with color legend', async () => {
  const printed = []
  const bitmap = {
    width: 200,
    height: 100,
    data: Buffer.alloc(200 * 100 * 4, 255),
  }
  const image = {
    bitmap,
    scan(x, y, width, height, iterator) {
      for (let pixelY = y; pixelY < y + height; pixelY += 1) {
        for (let pixelX = x; pixelX < x + width; pixelX += 1) {
          const idx = (bitmap.width * pixelY + pixelX) << 2
          iterator.call(this, pixelX, pixelY, idx)
        }
      }
    },
    print(...args) {
      printed.push(args)
    },
    writeAsync: async () => {},
  }
  const result = await overlayFocusScreenshot({
    targetPath: '/tmp/focus.png',
    config: { repoRoot: '/repo' },
    refs: [
      { ref: '@e1', kind: 'button', text: '工具箱', rectPct: { x: 10, y: 20, w: 20, h: 12 } },
      { ref: '@e2', kind: 'button', text: '我的', rectPct: { x: 40, y: 20, w: 20, h: 12 } },
    ],
    focusRefs: ['@e1', '@e2'],
    createImageAdapter: async () => image,
    colorAdapter: {
      rgbaToInt: (r, g, b, a) => (((r & 255) << 24) | ((g & 255) << 16) | ((b & 255) << 8) | (a & 255)) >>> 0,
      loadFont: async () => ({}),
      FONT_SANS_16_WHITE: 'font',
    },
  })

  const insideIdx = (bitmap.width * 25 + 30) << 2
  const insidePixel = Array.from(bitmap.data.slice(insideIdx, insideIdx + 4))
  const borderIdx = (bitmap.width * 20 + 20) << 2
  const borderPixel = Array.from(bitmap.data.slice(borderIdx, borderIdx + 4))
  const stripeIdx = (bitmap.width * 26 + 27) << 2
  const stripePixel = Array.from(bitmap.data.slice(stripeIdx, stripeIdx + 4))
  const gapIdx = (bitmap.width * 26 + 28) << 2
  const gapPixel = Array.from(bitmap.data.slice(gapIdx, gapIdx + 4))

  assert.deepEqual(result.focusLegend, [
    '@e1 [button] 工具箱 color=blue',
    '@e2 [button] 我的 color=green',
  ])
  assert.equal(printed.length >= 2, true)
  assert.notDeepEqual(insidePixel, [255, 255, 255, 255])
  assert.deepEqual(borderPixel, [15, 23, 42, 255])
  assert.notDeepEqual(stripePixel, gapPixel)
})
