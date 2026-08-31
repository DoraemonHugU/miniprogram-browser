const test = require('node:test')
const assert = require('node:assert/strict')

const {
  performElementSwipe,
  performPageScroll,
  performElementScroll,
  navigateBackWithFallback,
  readRuntimeChangeSignature,
  normalizeAwaitCondition,
  waitForMiniProgramCondition,
} = require('../dist/lib/runtime.js')

test('performElementSwipe sends a real touch sequence inside the element bounds', async () => {
  const calls = []
  const element = {
    tagName: 'view',
    async size() { return { width: '300', height: '180' } },
    async offset() { return { left: 10, top: 20 } },
    async touchstart(payload) { calls.push(['start', payload]) },
    async touchmove(payload) { calls.push(['move', payload]) },
    async touchend(payload) { calls.push(['end', payload]) },
  }

  const result = await performElementSwipe(element, 'left', 180)

  assert.equal(result.direction, 'left')
  assert.ok(result.distance > 0)
  assert.equal(calls[0][0], 'start')
  assert.equal(calls.at(-1)[0], 'end')
  assert.ok(calls.filter(([kind]) => kind === 'move').length >= 2)
  const startX = calls[0][1].touches[0].pageX
  const endX = calls.at(-1)[1].changeTouches[0].pageX
  assert.ok(startX > endX)
  assert.deepEqual(calls.at(-1)[1].changedTouches, calls.at(-1)[1].changeTouches)
})

test('performElementSwipe preserves rightward changedTouches for real gesture handlers', async () => {
  const calls = []
  const element = {
    tagName: 'view',
    async size() { return { width: 300, height: 180 } },
    async offset() { return { left: 10, top: 20 } },
    async touchstart(payload) { calls.push(['start', payload]) },
    async touchmove(payload) { calls.push(['move', payload]) },
    async touchend(payload) { calls.push(['end', payload]) },
  }

  await performElementSwipe(element, 'right', 180)

  const startX = calls[0][1].touches[0].clientX
  const end = calls.at(-1)[1]
  assert.ok(end.changedTouches[0].clientX > startX)
  assert.deepEqual(end.changedTouches, end.changeTouches)
})

test('performElementSwipe uses the native swiper action when touch events do not move it', async () => {
  let current = 0
  const element = {
    tagName: 'swiper',
    async size() { return { width: 300, height: 180 } },
    async offset() { return { left: 10, top: 20 } },
    async touchstart() {},
    async touchmove() {},
    async touchend() {},
    async property(name) {
      assert.equal(name, 'current')
      return current
    },
    async $$(selector) {
      assert.equal(selector, 'swiper-item')
      return [{}, {}, {}]
    },
    async attribute(name) {
      assert.equal(name, 'circular')
      return null
    },
    async swipeTo(index) { current = index },
  }

  await performElementSwipe(element, 'left', 180)

  assert.equal(current, 1)
})

test('performPageScroll updates the current page offset without a fixed sleep', async () => {
  const targets = []
  const page = { async scrollTop() { return '120' } }
  const miniProgram = { async pageScrollTo(value) { targets.push(value) } }

  const result = await performPageScroll(miniProgram, page, 'down', 300)

  assert.deepEqual(targets, [420])
  assert.equal(result.position, 420)
})

test('performElementScroll supports both axes and clamps at zero', async () => {
  const targets = []
  const element = {
    async property(name) { return name === 'scrollLeft' ? 40 : 20 },
    async scrollTo(x, y) { targets.push([x, y]) },
  }

  const result = await performElementScroll(element, 'left', 100)

  assert.deepEqual(targets, [[0, 20]])
  assert.deepEqual(result, { x: 0, y: 20, direction: 'left', distance: 100 })
})

test('navigateBackWithFallback uses runtime back when native reports success without changing route', async () => {
  let route = 'pages/detail/index'
  let runtimeBackCalls = 0
  const miniProgram = {
    async pageStack() {
      return [{ path: 'pages/index/index' }, { path: route }]
    },
    async currentPage() { return { path: route } },
    native() {
      return { async navigateLeft() { return { ok: true } } }
    },
    async callWxMethod(method) {
      assert.equal(method, 'navigateBack')
      runtimeBackCalls += 1
      route = 'pages/index/index'
    },
  }

  const result = await navigateBackWithFallback(miniProgram, {}, {
    nativeTimeoutMs: 1,
    timeoutMs: 20,
    pollMs: 1,
  })

  assert.equal(runtimeBackCalls, 1)
  assert.equal(result.mode, 'runtime-fallback')
  assert.equal(result.path, 'pages/index/index')
})

test('change await observes framework-neutral compiled WXML changes', async () => {
  let text = 'Idle'
  const page = {
    path: 'pages/interaction/index',
    query: {},
    async $$(selector) {
      if (selector !== 'view') return []
      return [{
        tagName: 'view',
        async text() { return text },
        async outerWxml() { return `<view id="status">${text}</view>` },
      }]
    },
  }
  const miniProgram = {
    async currentPage() { return page },
    async pageStack() { return [page] },
  }
  const baseline = await readRuntimeChangeSignature(miniProgram)
  text = 'Changed'

  const result = await waitForMiniProgramCondition(
    miniProgram,
    { route: page.path, refs: {} },
    normalizeAwaitCondition('change'),
    { signatureBefore: baseline.signature, timeout: 50, pollMs: 1 },
  )

  assert.equal(result.ok, true)
  assert.equal(result.changed, true)
})

test('standalone change await rejects because it has no action baseline', async () => {
  const miniProgram = {
    async currentPage() { return { path: 'pages/index/index' } },
  }

  await assert.rejects(
    waitForMiniProgramCondition(
      miniProgram,
      { route: 'pages/index/index', refs: {} },
      normalizeAwaitCondition('change'),
      { timeout: 10 },
    ),
    /only available after an action|只能用于动作/u,
  )
})
