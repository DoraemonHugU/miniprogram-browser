const test = require('node:test')
const assert = require('node:assert/strict')

const {
  captureVisualScreenshot,
  captureAnnotatedScreenshot,
  captureLayoutScreenshot,
  overlayFocusScreenshot,
  layoutColorScheme,
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

test('captureAnnotatedScreenshot hides ref labels when noRef is enabled', async () => {
  const printed = []
  const result = await captureAnnotatedScreenshot({
    miniProgram: {},
    targetPath: '/tmp/annotate-no-ref.png',
    config: { repoRoot: '/repo' },
    refs: [
      { ref: '@e1', kind: 'button', text: '开始', rectPct: { x: 10, y: 20, w: 20, h: 10 } },
    ],
    noRef: true,
    pageCapture: async (targetPath) => targetPath,
    createImageAdapter: async () => ({
      bitmap: { width: 200, height: 100 },
      scan: () => {},
      composite: () => {},
      print: (...args) => { printed.push(args) },
      writeAsync: async () => {},
    }),
    colorAdapter: {
      rgbaToInt: () => 0,
      create: async () => ({ bitmap: { width: 1, height: 1 }, scan: () => {} }),
      loadFont: async () => ({}),
      FONT_SANS_16_WHITE: 'font',
    },
  })

  assert.equal(result.mode, 'annotate')
  assert.deepEqual(result.legend, [])
  assert.equal(printed.length, 0)
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

test('overlayFocusScreenshot hides focus labels when noRef is enabled', async () => {
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
    targetPath: '/tmp/focus-no-ref.png',
    config: { repoRoot: '/repo' },
    refs: [
      { ref: '@e1', kind: 'button', text: '工具箱', rectPct: { x: 10, y: 20, w: 20, h: 12 } },
    ],
    focusRefs: ['@e1'],
    noRef: true,
    createImageAdapter: async () => image,
    colorAdapter: {
      rgbaToInt: (r, g, b, a) => (((r & 255) << 24) | ((g & 255) << 16) | ((b & 255) << 8) | (a & 255)) >>> 0,
      loadFont: async () => ({}),
      FONT_SANS_16_WHITE: 'font',
    },
  })

  assert.deepEqual(result.focusLegend, ['@e1 [button] 工具箱 color=blue'])
  assert.equal(printed.length, 0)
})

test('captureLayoutScreenshot renders layout fallback and supports focus overlay', async () => {
  const printed = []
  const bitmap = {
    width: 420,
    height: 800,
    data: Buffer.alloc(420 * 800 * 4, 255),
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

  const result = await captureLayoutScreenshot({
    targetPath: '/tmp/layout.png',
    config: { repoRoot: '/repo' },
    refs: [
      { ref: '@e1', kind: 'view', text: '', rectPct: { x: 0, y: 0, w: 100, h: 100 } },
      { ref: '@e2', kind: 'button', text: '工具箱', rectPct: { x: 10, y: 20, w: 30, h: 8 } },
      { ref: '@e3', kind: 'text', text: '继续学习', rectPct: { x: 12, y: 40, w: 25, h: 4 } },
    ],
    focusRefs: ['@e2'],
    systemInfo: { windowWidth: 375, windowHeight: 812 },
    createImageAdapter: async () => image,
    colorAdapter: {
      create: async () => image,
      rgbaToInt: (r, g, b, a) => (((r & 255) << 24) | ((g & 255) << 16) | ((b & 255) << 8) | (a & 255)) >>> 0,
      loadFont: async () => ({}),
      FONT_SANS_16_WHITE: 'font',
    },
  })

  assert.equal(result.mode, 'layout')
  assert.equal(result.source, 'layout+focus')
  assert.deepEqual(result.focusLegend, ['@e2 [button] 工具箱 color=blue'])
  assert.equal(printed.length >= 3, true)
})

test('captureLayoutScreenshot hides semantic ref badges when noRef is enabled', async () => {
  const printed = []
  const bitmap = {
    width: 420,
    height: 800,
    data: Buffer.alloc(420 * 800 * 4, 255),
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

  await captureLayoutScreenshot({
    targetPath: '/tmp/layout-no-ref.png',
    config: { repoRoot: '/repo' },
    refs: [
      { ref: '@e1', kind: 'view', text: '', rectPct: { x: 0, y: 0, w: 100, h: 100 } },
      { ref: '@e2', kind: 'button', text: '工具箱', rectPct: { x: 10, y: 20, w: 30, h: 8 } },
    ],
    badgeRecords: [
      { ref: '@e1', kind: 'view', text: '', rectPct: { x: 0, y: 0, w: 100, h: 100 } },
      { ref: '@e2', kind: 'button', text: '工具箱', rectPct: { x: 10, y: 20, w: 30, h: 8 } },
    ],
    noRef: true,
    focusRefs: [],
    systemInfo: { windowWidth: 375, windowHeight: 812 },
    createImageAdapter: async () => image,
    colorAdapter: {
      create: async () => image,
      rgbaToInt: (r, g, b, a) => (((r & 255) << 24) | ((g & 255) << 16) | ((b & 255) << 8) | (a & 255)) >>> 0,
      loadFont: async () => ({}),
      FONT_SANS_16_WHITE: 'font',
    },
    textRenderer: async () => {},
  })

  assert.equal(printed.length, 0)
})

test('captureLayoutScreenshot uses deterministic different fills for top-level groups', async () => {
  const bitmap = {
    width: 420,
    height: 800,
    data: Buffer.alloc(420 * 800 * 4, 255),
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
    print() {},
    writeAsync: async () => {},
  }

  await captureLayoutScreenshot({
    targetPath: '/tmp/layout-groups.png',
    config: { repoRoot: '/repo' },
    refs: [
      { ref: '@e1', kind: 'view', text: '', rectPct: { x: 5, y: 5, w: 40, h: 20 } },
      { ref: '@e2', kind: 'view', text: '', rectPct: { x: 55, y: 5, w: 40, h: 20 } },
    ],
    focusRefs: [],
    systemInfo: { windowWidth: 375, windowHeight: 812 },
    createImageAdapter: async () => image,
    colorAdapter: {
      create: async () => image,
      rgbaToInt: (r, g, b, a) => (((r & 255) << 24) | ((g & 255) << 16) | ((b & 255) << 8) | (a & 255)) >>> 0,
      loadFont: async () => ({}),
      FONT_SANS_16_WHITE: 'font',
    },
  })

  const leftIdx = (bitmap.width * 80 + 60) << 2
  const rightIdx = (bitmap.width * 80 + 260) << 2
  const leftPixel = Array.from(bitmap.data.slice(leftIdx, leftIdx + 4))
  const rightPixel = Array.from(bitmap.data.slice(rightIdx, rightIdx + 4))

  assert.notDeepEqual(leftPixel, rightPixel)
})

test('layoutColorScheme is deterministic and differentiates sibling identities', () => {
  const Jimp = { rgbaToInt: (r, g, b, a) => (((r & 255) << 24) | ((g & 255) << 16) | ((b & 255) << 8) | (a & 255)) >>> 0 }
  const metrics = new Map([
    ['view:a', { depth: 0, group: 0 }],
    ['view:b', { depth: 0, group: 1 }],
  ])
  const a1 = layoutColorScheme(Jimp, { kind: 'view', businessKey: 'a', selector: '[id="a"]' }, metrics)
  const a2 = layoutColorScheme(Jimp, { kind: 'view', businessKey: 'a', selector: '[id="a"]' }, metrics)
  const b = layoutColorScheme(Jimp, { kind: 'view', businessKey: 'b', selector: '[id="b"]' }, metrics)

  assert.equal(a1.fill, a2.fill)
  assert.equal(a1.labelBg, a2.labelBg)
  assert.notEqual(a1.fill, b.fill)
  assert.notEqual(a1.labelBg, b.labelBg)
})

test('captureLayoutScreenshot invokes text renderer when provided', async () => {
  let renderedTexts = []
  await captureLayoutScreenshot({
    targetPath: '/tmp/layout-text.png',
    config: { repoRoot: '/repo' },
    refs: [
      { ref: '@e1', kind: 'view', text: '学习打卡 <常用工具>', rectPct: { x: 10, y: 20, w: 30, h: 8 } },
      { ref: '@e2', kind: 'text', text: '学习打卡', parentRef: '@e1', rectPct: { x: 12, y: 22, w: 25, h: 4 } },
      { ref: '@e3', kind: 'button', text: '工具箱 <常用工具>', rectPct: { x: 12, y: 40, w: 25, h: 4 } },
    ],
    focusRefs: [],
    systemInfo: { windowWidth: 375, windowHeight: 812 },
    createImageAdapter: async () => ({
      bitmap: { width: 420, height: 800, data: Buffer.alloc(420 * 800 * 4, 255) },
      scan() {},
      print() {},
      writeAsync: async () => {},
      composite() {},
    }),
    colorAdapter: {
      create: async () => ({
        bitmap: { width: 420, height: 800, data: Buffer.alloc(420 * 800 * 4, 255) },
        scan() {},
        print() {},
        writeAsync: async () => {},
        composite() {},
      }),
      rgbaToInt: (r, g, b, a) => (((r & 255) << 24) | ((g & 255) << 16) | ((b & 255) << 8) | (a & 255)) >>> 0,
      loadFont: async () => ({}),
      FONT_SANS_16_WHITE: 'font',
    },
    textRenderer: async ({ textItems }) => {
      renderedTexts = textItems.map((item) => item.text)
    },
  })

  assert.deepEqual(renderedTexts, ['学习打卡', '工具箱'])
})

test('captureLayoutScreenshot deduplicates parent and child text content', async () => {
  let renderedTexts = []
  await captureLayoutScreenshot({
    targetPath: '/tmp/layout-text-dedupe.png',
    config: { repoRoot: '/repo' },
    refs: [
      { businessKey: 'root', kind: 'view', text: '', rectPct: { x: 0, y: 0, w: 100, h: 100 } },
      { businessKey: 'button', parentRef: 'root', kind: 'button', text: '学习打卡', rectPct: { x: 10, y: 20, w: 30, h: 8 } },
      { businessKey: 'label', parentRef: 'button', kind: 'text', text: '学习打卡', rectPct: { x: 12, y: 22, w: 25, h: 4 } },
    ],
    focusRefs: [],
    systemInfo: { windowWidth: 375, windowHeight: 812 },
    createImageAdapter: async () => ({
      bitmap: { width: 420, height: 800, data: Buffer.alloc(420 * 800 * 4, 255) },
      scan() {},
      print() {},
      writeAsync: async () => {},
      composite() {},
    }),
    colorAdapter: {
      create: async () => ({
        bitmap: { width: 420, height: 800, data: Buffer.alloc(420 * 800 * 4, 255) },
        scan() {},
        print() {},
        writeAsync: async () => {},
        composite() {},
      }),
      rgbaToInt: (r, g, b, a) => (((r & 255) << 24) | ((g & 255) << 16) | ((b & 255) << 8) | (a & 255)) >>> 0,
      loadFont: async () => ({}),
      FONT_SANS_16_WHITE: 'font',
    },
    textRenderer: async ({ textItems }) => {
      renderedTexts = textItems.map((item) => item.text)
    },
  })

  assert.deepEqual(renderedTexts, ['学习打卡'])
})

test('captureLayoutScreenshot deduplicates parent text against deep descendant text content', async () => {
  let renderedTexts = []
  await captureLayoutScreenshot({
    targetPath: '/tmp/layout-text-deep-dedupe.png',
    config: { repoRoot: '/repo' },
    refs: [
      { businessKey: 'root', kind: 'view', text: '', rectPct: { x: 0, y: 0, w: 100, h: 100 } },
      { businessKey: 'button', parentRef: 'root', kind: 'button', text: '学习打卡', rectPct: { x: 10, y: 20, w: 30, h: 8 } },
      { businessKey: 'inner', parentRef: 'button', kind: 'view', text: '', rectPct: { x: 11, y: 21, w: 26, h: 6 } },
      { businessKey: 'label', parentRef: 'inner', kind: 'text', text: '学习打卡', rectPct: { x: 12, y: 22, w: 25, h: 4 } },
    ],
    focusRefs: [],
    systemInfo: { windowWidth: 375, windowHeight: 812 },
    createImageAdapter: async () => ({
      bitmap: { width: 420, height: 800, data: Buffer.alloc(420 * 800 * 4, 255) },
      scan() {},
      print() {},
      writeAsync: async () => {},
      composite() {},
    }),
    colorAdapter: {
      create: async () => ({
        bitmap: { width: 420, height: 800, data: Buffer.alloc(420 * 800 * 4, 255) },
        scan() {},
        print() {},
        writeAsync: async () => {},
        composite() {},
      }),
      rgbaToInt: (r, g, b, a) => (((r & 255) << 24) | ((g & 255) << 16) | ((b & 255) << 8) | (a & 255)) >>> 0,
      loadFont: async () => ({}),
      FONT_SANS_16_WHITE: 'font',
    },
    textRenderer: async ({ textItems }) => {
      renderedTexts = textItems.map((item) => item.text)
    },
  })

  assert.deepEqual(renderedTexts, ['学习打卡'])
})

test('captureLayoutScreenshot offsets nearby ref badges to avoid overlap', async () => {
  const printed = []
  await captureLayoutScreenshot({
    targetPath: '/tmp/layout-badges.png',
    config: { repoRoot: '/repo' },
    refs: [
      { ref: '@e1', kind: 'view', text: '', rectPct: { x: 5, y: 5, w: 90, h: 10 } },
      { ref: '@e2', kind: 'text', text: '标题', parentRef: '@e1', rectPct: { x: 6, y: 6, w: 20, h: 3 } },
      { ref: '@e3', kind: 'text', text: '副标题', parentRef: '@e1', rectPct: { x: 6, y: 9, w: 20, h: 3 } },
    ],
    focusRefs: [],
    systemInfo: { windowWidth: 375, windowHeight: 812 },
    createImageAdapter: async () => ({
      bitmap: { width: 420, height: 800, data: Buffer.alloc(420 * 800 * 4, 255) },
      scan() {},
      print(...args) { printed.push(args) },
      writeAsync: async () => {},
      composite() {},
    }),
    colorAdapter: {
      create: async () => ({
        bitmap: { width: 420, height: 800, data: Buffer.alloc(420 * 800 * 4, 255) },
        scan() {},
        print(...args) { printed.push(args) },
        writeAsync: async () => {},
        composite() {},
      }),
      rgbaToInt: (r, g, b, a) => (((r & 255) << 24) | ((g & 255) << 16) | ((b & 255) << 8) | (a & 255)) >>> 0,
      loadFont: async () => ({}),
      FONT_SANS_16_WHITE: 'font',
    },
    textRenderer: async () => {},
  })

  const badgeCalls = printed.filter((item) => String(item[3] || '').startsWith('@e'))
  const positions = badgeCalls.map((item) => `${item[1]},${item[2]}`)
  assert.equal(new Set(positions).size, positions.length)
})

test('captureLayoutScreenshot provides text safe boxes away from badge overlap', async () => {
  let safeBoxes = []
  await captureLayoutScreenshot({
    targetPath: '/tmp/layout-safe-box.png',
    config: { repoRoot: '/repo' },
    refs: [
      { ref: '@e1', kind: 'view', text: '', rectPct: { x: 5, y: 5, w: 90, h: 12 } },
      { ref: '@e2', kind: 'text', text: '标题', parentRef: '@e1', rectPct: { x: 6, y: 6, w: 30, h: 4 } },
    ],
    badgeRecords: [
      { ref: '@e1', kind: 'view', text: '', rectPct: { x: 5, y: 5, w: 90, h: 12 } },
    ],
    focusRefs: [],
    systemInfo: { windowWidth: 375, windowHeight: 812 },
    createImageAdapter: async () => ({
      bitmap: { width: 420, height: 800, data: Buffer.alloc(420 * 800 * 4, 255) },
      scan() {},
      print() {},
      writeAsync: async () => {},
      composite() {},
    }),
    colorAdapter: {
      create: async () => ({
        bitmap: { width: 420, height: 800, data: Buffer.alloc(420 * 800 * 4, 255) },
        scan() {},
        print() {},
        writeAsync: async () => {},
        composite() {},
      }),
      rgbaToInt: (r, g, b, a) => (((r & 255) << 24) | ((g & 255) << 16) | ((b & 255) << 8) | (a & 255)) >>> 0,
      loadFont: async () => ({}),
      FONT_SANS_16_WHITE: 'font',
    },
    textRenderer: async ({ textItems }) => {
      safeBoxes = textItems.map((item) => item.safeBox)
    },
  })

  assert.equal(safeBoxes.length, 1)
  assert.ok(safeBoxes[0].y > 48)
})
