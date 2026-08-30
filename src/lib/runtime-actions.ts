/**
 * runtime-actions.ts — 面向真实用户操作的通用动作。
 *
 * 这些函数只依赖微信自动化协议的 page/element/native 能力，不读取原生、Taro、
 * uni-app 的源码状态，也不通过 setData/eval 伪造交互结果。通用滑动先发送真实
 * touch 序列；原生 swiper 不响应该序列时，使用 automator 官方的 swipeTo 组件动作。
 */

const {
  getCurrentPage,
  getPageStack,
  callNativeMethod,
  navigateMiniProgramBack,
} = require('./runtime-bridge')
const { normalizeRuntimeRoute } = require('./runtime-core')
const { sleep } = require('./runtime-wait')

type AnyRecord = Record<string, unknown>
type SleepFn = (ms: number) => Promise<void>

const DIRECTIONS = new Set(['up', 'down', 'left', 'right'])

function actionUsageError(message: string): Error & AnyRecord {
  const error = new Error(message) as Error & AnyRecord
  error.code = 'CLI_USAGE_ERROR'
  return error
}

function normalizeActionDirection(value: unknown, allowed: string[] = [...DIRECTIONS]): string {
  const direction = String(value || '').trim().toLowerCase()
  if (!allowed.includes(direction)) {
    throw actionUsageError(`Unsupported direction: ${direction || '(empty)'}. Use ${allowed.join('|')}.`)
  }
  return direction
}

function normalizeActionDistance(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === '') {
    return fallback
  }
  const distance = Number(value)
  if (!Number.isFinite(distance) || distance <= 0) {
    throw actionUsageError(`Distance must be a positive number: ${String(value)}`)
  }
  return Math.round(distance)
}

function numericValue(value: unknown): number {
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const numeric = Number(value[index])
      if (Number.isFinite(numeric)) {
        return numeric
      }
    }
    return 0
  }
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : 0
}

async function performPageScroll(miniProgram: AnyRecord, page: AnyRecord, rawDirection: unknown, rawDistance: unknown): Promise<AnyRecord> {
  const direction = normalizeActionDirection(rawDirection, ['up', 'down'])
  const distance = normalizeActionDistance(rawDistance, 300)
  if (typeof page.scrollTop !== 'function' || typeof miniProgram.pageScrollTo !== 'function') {
    throw new Error('Current DevTools automation runtime does not support page scrolling.')
  }

  const current = numericValue(await page.scrollTop())
  const position = Math.max(0, current + (direction === 'down' ? distance : -distance))
  await miniProgram.pageScrollTo(position)
  return { position, direction, distance }
}

async function performElementScroll(element: AnyRecord, rawDirection: unknown, rawDistance: unknown): Promise<AnyRecord> {
  const direction = normalizeActionDirection(rawDirection)
  const distance = normalizeActionDistance(rawDistance, 300)
  if (typeof element.property !== 'function' || typeof element.scrollTo !== 'function') {
    throw new Error('Target is not a scrollable scroll-view element.')
  }

  const [currentXValue, currentYValue] = await Promise.all([
    element.property('scrollLeft'),
    element.property('scrollTop'),
  ])
  let x = numericValue(currentXValue)
  let y = numericValue(currentYValue)
  if (direction === 'left') x = Math.max(0, x - distance)
  if (direction === 'right') x += distance
  if (direction === 'up') y = Math.max(0, y - distance)
  if (direction === 'down') y += distance
  await element.scrollTo(x, y)
  return { x, y, direction, distance }
}

function touchPoint(x: number, y: number): AnyRecord {
  return {
    identifier: 1,
    pageX: Math.round(x),
    pageY: Math.round(y),
    clientX: Math.round(x),
    clientY: Math.round(y),
  }
}

async function performElementSwipe(element: AnyRecord, rawDirection: unknown, rawDistance: unknown): Promise<AnyRecord> {
  const direction = normalizeActionDirection(rawDirection)
  const requestedDistance = normalizeActionDistance(rawDistance, 180)
  for (const method of ['size', 'offset', 'touchstart', 'touchmove', 'touchend']) {
    if (typeof element[method] !== 'function') {
      throw new Error(`Target does not support a real touch swipe: missing ${method}().`)
    }
  }

  const actionElement = element as unknown as {
    size(): Promise<AnyRecord>
    offset(): Promise<AnyRecord>
    touchstart(payload: AnyRecord): Promise<void>
    touchmove(payload: AnyRecord): Promise<void>
    touchend(payload: AnyRecord): Promise<void>
  }

  const [sizeValue, offsetValue] = await Promise.all([actionElement.size(), actionElement.offset()])
  const size = (sizeValue || {}) as AnyRecord
  const offset = (offsetValue || {}) as AnyRecord
  const width = numericValue(size.width)
  const height = numericValue(size.height)
  if (width <= 0 || height <= 0) {
    throw new Error('Target has no visible bounds for swipe.')
  }

  const left = numericValue(offset.left ?? offset.x)
  const top = numericValue(offset.top ?? offset.y)
  const centerX = left + width / 2
  const centerY = top + height / 2
  const horizontal = direction === 'left' || direction === 'right'
  const maximumDistance = Math.max(1, (horizontal ? width : height) * 0.8)
  const distance = Math.min(requestedDistance, maximumDistance)
  const sign = direction === 'left' || direction === 'up' ? -1 : 1
  const startX = horizontal ? centerX - sign * distance / 2 : centerX
  const startY = horizontal ? centerY : centerY - sign * distance / 2
  const endX = horizontal ? centerX + sign * distance / 2 : centerX
  const endY = horizontal ? centerY : centerY + sign * distance / 2
  const start = touchPoint(startX, startY)
  const end = touchPoint(endX, endY)
  const swiperElement = element as unknown as {
    tagName?: string
    property(name: string): Promise<unknown>
    swipeTo(index: number): Promise<void>
    $$(selector: string): Promise<unknown[]>
    attribute(name: string): Promise<unknown>
  }
  const isNativeSwiper = element.tagName === 'swiper'
    && typeof element.property === 'function'
    && typeof element.swipeTo === 'function'
  const currentBefore = isNativeSwiper
    ? numericValue(await swiperElement.property('current'))
    : null

  await actionElement.touchstart({ touches: [start], changeTouches: [start] })
  await sleep(30)
  for (const progress of [0.34, 0.67, 1]) {
    const point = touchPoint(
      startX + (endX - startX) * progress,
      startY + (endY - startY) * progress,
    )
    await actionElement.touchmove({ touches: [point], changeTouches: [point] })
    await sleep(30)
  }
  await actionElement.touchend({ touches: [], changeTouches: [end] })

  if (isNativeSwiper && currentBefore !== null) {
    await sleep(80)
    const currentAfterTouch = numericValue(await swiperElement.property('current'))
    if (currentAfterTouch === currentBefore) {
      const items = typeof element.$$ === 'function'
        ? await swiperElement.$$('swiper-item').catch(() => [])
        : []
      const itemCount = Array.isArray(items) ? items.length : 0
      const forward = direction === 'left' || direction === 'up'
      let targetIndex = currentBefore + (forward ? 1 : -1)
      const circularValue = typeof element.attribute === 'function'
        ? await swiperElement.attribute('circular').catch(() => null)
        : null
      const circular = circularValue === true || String(circularValue || '') === 'true'

      if (itemCount > 0 && circular) {
        targetIndex = (targetIndex + itemCount) % itemCount
      } else if (itemCount > 0) {
        targetIndex = Math.max(0, Math.min(itemCount - 1, targetIndex))
      }

      if (targetIndex === currentBefore) {
        throw actionUsageError(`Cannot swipe ${direction}: swiper is already at its boundary.`)
      }
      await swiperElement.swipeTo(targetIndex)
    }
  }

  return { direction, distance: Math.round(distance) }
}

async function waitForPathChange(miniProgram: AnyRecord, pathBefore: string, options: AnyRecord): Promise<string> {
  const timeoutMs = Math.max(0, Number(options.timeoutMs || 0))
  const pollMs = Math.max(1, Number(options.pollMs || 50))
  const sleepFn = (options.sleepFn as SleepFn) || sleep
  const startedAt = Date.now()

  do {
    const page = await getCurrentPage(miniProgram).catch(() => null)
    const path = normalizeRuntimeRoute(page && page.path ? page.path : '')
    if (path && path !== pathBefore) {
      return path
    }
    if (Date.now() - startedAt >= timeoutMs) {
      break
    }
    await sleepFn(pollMs)
  } while (Date.now() - startedAt <= timeoutMs)

  return pathBefore
}

async function navigateBackWithFallback(miniProgram: AnyRecord, _state: AnyRecord, options: AnyRecord = {}): Promise<AnyRecord> {
  const stack = await getPageStack(miniProgram)
  if (stack.length <= 1) {
    const error = new Error('Cannot go back: the current page stack has no previous page.') as Error & AnyRecord
    error.code = 'NAVIGATION_STACK_EMPTY'
    error.hint = 'Use goto <route> when you need to open a specific page.'
    throw error
  }

  const pageBefore = await getCurrentPage(miniProgram)
  const pathBefore = normalizeRuntimeRoute(pageBefore && pageBefore.path ? pageBefore.path : '')
  const nativeTimeoutMs = Math.max(0, Number(options.nativeTimeoutMs ?? 350))
  const timeoutMs = Math.max(1, Number(options.timeoutMs ?? options.timeout ?? 3000))
  const pollMs = Math.max(1, Number(options.pollMs || 50))
  let nativeResult: unknown = null

  try {
    nativeResult = await callNativeMethod(miniProgram, 'navigateLeft')
    const nativePath = await waitForPathChange(miniProgram, pathBefore, {
      timeoutMs: nativeTimeoutMs,
      pollMs,
      sleepFn: options.sleepFn,
    })
    if (nativePath !== pathBefore) {
      return { path: nativePath, pathBefore, mode: 'native', nativeResult }
    }
  } catch (_error: unknown) {
    // native 手势在不同 DevTools 版本上并不稳定；下面使用同一页面栈语义回退。
  }

  await navigateMiniProgramBack(miniProgram)
  const path = await waitForPathChange(miniProgram, pathBefore, {
    timeoutMs,
    pollMs,
    sleepFn: options.sleepFn,
  })
  if (path === pathBefore) {
    const error = new Error(`back failed: current page is still ${pathBefore || '(unknown)'}.`) as Error & AnyRecord
    error.code = 'BACK_FAILED'
    throw error
  }
  return { path, pathBefore, mode: 'runtime-fallback', nativeResult }
}

module.exports = {
  normalizeActionDirection,
  normalizeActionDistance,
  performPageScroll,
  performElementScroll,
  performElementSwipe,
  navigateBackWithFallback,
}
