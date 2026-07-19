/**
 * runtime-timeline.ts — 路由时间线监控
 *
 * 本模块包含 miniprogram-browser 的路由时间线监控功能：
 * - 在小程序运行时注入 wx.onAppRoute 监听
 * - 同步采集路由事件到 state
 * - 时间线事件的存取
 */

const { normalizeRouteTimelineEvent } = require('./runtime-core')

type AnyRecord = Record<string, unknown>

/** 路由时间线存储上限 */
const ROUTE_TIMELINE_LIMIT = 200

/**
 * 在 miniProgram 运行时中注入路由时间线监控。
 * 通过 wx.onAppRoute 拦截路由变化，将事件存储在 globalThis.__MPB_ROUTE_EVENTS__。
 */
async function ensureRouteTimelineMonitor(miniProgram: AnyRecord): Promise<AnyRecord> {
  if (typeof miniProgram.evaluate !== 'function') {
    return { installed: false, supported: false }
  }

  return miniProgram.evaluate(() => {
    const globalObject = globalThis as AnyRecord
    const getCurrentPath = () => {
      try {
        if (typeof getCurrentPages !== 'function') {
          return ''
        }
        const pages = getCurrentPages() as AnyRecord[]
        const currentPage = Array.isArray(pages) ? pages[pages.length - 1] : null
        return currentPage && currentPage.route ? String(currentPage.route).replace(/^\//, '') : ''
      } catch (_) {
        return ''
      }
    }

    const routeEvents = globalObject.__MPB_ROUTE_EVENTS__ as unknown[] | undefined
    globalObject.__MPB_ROUTE_EVENTS__ = Array.isArray(routeEvents)
      ? routeEvents
      : []
    globalObject.__MPB_ROUTE_SEQ__ = Number(globalObject.__MPB_ROUTE_SEQ__ || 0)
    globalObject.__MPB_LAST_ROUTE_PATH__ = (globalObject.__MPB_LAST_ROUTE_PATH__ as string) || getCurrentPath()

    if (globalObject.__MPB_ROUTE_MONITOR_INSTALLED__) {
      return { installed: true, supported: typeof wx !== 'undefined' && typeof wx.onAppRoute === 'function' }
    }

    if (typeof wx === 'undefined' || typeof wx.onAppRoute !== 'function') {
      return { installed: false, supported: false }
    }

    wx.onAppRoute((res: AnyRecord = {}) => {
      const from = String(globalObject.__MPB_LAST_ROUTE_PATH__ || '').replace(/^\//, '')
      const to = String(res.path || '').replace(/^\//, '')
      const openType = String(res.openType || 'route')
      const routeSeq = (globalObject.__MPB_ROUTE_SEQ__ as number) || 0
      globalObject.__MPB_ROUTE_SEQ__ = routeSeq + 1
      const routeEvents = globalObject.__MPB_ROUTE_EVENTS__ as AnyRecord[]
      routeEvents.push({
        seq: globalObject.__MPB_ROUTE_SEQ__,
        ts: Date.now(),
        from,
        to,
        openType,
      })
      if (routeEvents.length > 200) {
        globalObject.__MPB_ROUTE_EVENTS__ = routeEvents.slice(-200)
      }
      if (to) {
        globalObject.__MPB_LAST_ROUTE_PATH__ = to
      }
    })

    globalObject.__MPB_ROUTE_MONITOR_INSTALLED__ = true
    return { installed: true, supported: true }
  })
}

/**
 * 从 miniProgram 同步路由时间线事件到 state。
 * 返回自上次同步以来的新事件。
 */
async function syncRouteTimelineEvents(miniProgram: AnyRecord, state: AnyRecord): Promise<AnyRecord> {
  if (typeof miniProgram.evaluate !== 'function') {
    return { events: [], lastSeq: Number(state.lastRouteEventSeq || 0) }
  }

  const rawEvents = await miniProgram.evaluate(() => {
    const g = globalThis as AnyRecord
    return Array.isArray(g.__MPB_ROUTE_EVENTS__) ? g.__MPB_ROUTE_EVENTS__ : []
  })
  const lastSeenSeq = Number(state.lastRouteEventSeq || 0)
  const events = (rawEvents as AnyRecord[])
    .map((item: AnyRecord) => normalizeRouteTimelineEvent(item))
    .filter((event: AnyRecord) => Number(event.seq) > lastSeenSeq)
  const nextSeq = events.length ? Number((events[events.length - 1] as AnyRecord).seq) : lastSeenSeq

  state.routeEvents = [
    ...(Array.isArray(state.routeEvents) ? state.routeEvents : []),
    ...events.map((item: AnyRecord) => {
      const { seq: _seq, ...rest } = item
      return rest
    }),
  ].slice(-200)
  state.lastRouteEventSeq = nextSeq

  return {
    events,
    lastSeq: nextSeq,
  }
}

module.exports = {
  ensureRouteTimelineMonitor,
  syncRouteTimelineEvents,
}
