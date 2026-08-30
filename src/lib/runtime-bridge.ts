/**
 * runtime-bridge.ts — 小程序原生桥接函数
 *
 * 本模块包含直接调用 miniProgram/page API 的轻量桥接函数。
 * 所有函数为纯"转发"操作，不涉及状态管理和复杂逻辑。
 */

import type { MiniProgram } from 'miniprogram-automator'

/** 页面句柄（由 MiniProgram.pageStack / currentPage 返回） */
interface PageHandle {
  path?: string
  query?: Record<string, unknown>
  callMethod(method: string, ...args: unknown[]): Promise<unknown>
  $(selector: string): Promise<ElementHandle | null>
  $$(selector: string): Promise<ElementHandle[]>
}

/** 元素句柄（由 page.$ / page.$$ 返回） */
interface ElementHandle {
  attribute(name: string): Promise<unknown>
  property(name: string): Promise<unknown>
  size(): Promise<unknown>
  offset(): Promise<unknown>
  text(): Promise<string>
  $(selector: string): Promise<ElementHandle | null>
  $$(selector: string): Promise<ElementHandle[]>
}

/** 解析原始参数列表：尝试 JSON.parse，保留 undefined */
function parseCallArguments(rawArgs: string[]): unknown[] {
  return (rawArgs || []).map((item) => {
    if (item === undefined) {
      return item
    }

    try {
      return JSON.parse(item)
    } catch (_) {
      return item
    }
  })
}

/** 获取小程序当前页面 */
async function getCurrentPage(miniProgram: MiniProgram): Promise<PageHandle> {
  const page = await miniProgram.currentPage()
  if (!page) {
    throw new Error('No current page')
  }
  return page as PageHandle
}

/** 获取系统信息 */
async function getSystemInfo(miniProgram: MiniProgram): Promise<unknown> {
  return miniProgram.systemInfo()
}

/** 获取页面栈 */
async function getPageStack(miniProgram: MiniProgram): Promise<{ path?: string; query?: Record<string, unknown> }[]> {
  const stack = await miniProgram.pageStack() as { path?: string; query?: Record<string, unknown> }[]
  return (stack || []).map((page) => ({
    path: page.path,
    query: page.query,
  }))
}

/** 调用 wx 方法 */
async function callWxMethod(miniProgram: MiniProgram, method: string, rawArgs: string[] = []): Promise<unknown> {
  return miniProgram.callWxMethod(method, ...parseCallArguments(rawArgs))
}

/**
 * 直接调用路由 wx API，避开 miniprogram-automator changeRoute 内置的固定 3 秒 sleep。
 * 插件页面沿用 SDK 原有的 pluginId 分发规则。
 */
async function changeMiniProgramRoute(miniProgram: MiniProgram, method: 'reLaunch' | 'switchTab', url: string): Promise<unknown> {
  const currentPage = await miniProgram.currentPage().catch(() => null)
  const pluginMatch = currentPage && currentPage.path
    ? String(currentPage.path).match(/^plugin-private:\/\/([^/]+)\//u)
    : null

  if (pluginMatch && typeof miniProgram.callPluginWxMethod === 'function') {
    return miniProgram.callPluginWxMethod(pluginMatch[1], method, { url })
  }
  return miniProgram.callWxMethod(method, { url })
}

/** 返回上一页，避开 automator.navigateBack() 内置的固定 3 秒等待。 */
async function navigateMiniProgramBack(miniProgram: MiniProgram): Promise<unknown> {
  const currentPage = await miniProgram.currentPage().catch(() => null)
  const pluginMatch = currentPage && currentPage.path
    ? String(currentPage.path).match(/^plugin-private:\/\/([^/]+)\//u)
    : null

  if (pluginMatch && typeof miniProgram.callPluginWxMethod === 'function') {
    return miniProgram.callPluginWxMethod(pluginMatch[1], 'navigateBack')
  }
  return miniProgram.callWxMethod('navigateBack')
}

/** 调用页面方法 */
async function callPageMethod(page: PageHandle, method: string, rawArgs: string[] = []): Promise<unknown> {
  return page.callMethod(method, ...parseCallArguments(rawArgs))
}

/** 在小程序中执行 JS */
async function evaluateInMiniProgram(miniProgram: MiniProgram, source: unknown): Promise<unknown> {
  const script = String(source || '').trim()
  if (!script) {
    throw new Error('eval requires JavaScript source')
  }

  const functionDeclaration = /^async\s+function\b/u.test(script) || /^function\b/u.test(script)
    ? script
    : /(^|\s)return\b/u.test(script) || /[;\n]/u.test(script)
      ? `function () { ${script} }`
      : `function () { return (${script}) }`

  return miniProgram.evaluate(functionDeclaration)
}

/** 调用 native 方法 */
async function callNativeMethod(miniProgram: MiniProgram, method: string, rawArgs: string[] = []): Promise<unknown> {
  if (!method) {
    throw new Error('native requires a method name')
  }

  const native = miniProgram.native() as Record<string, unknown> | null
  const handler = native && (native[method] as ((...args: unknown[]) => unknown) | undefined)
  if (typeof handler !== 'function') {
    throw new Error(`Unknown native method: ${method}`)
  }

  return handler.apply(native, parseCallArguments(rawArgs))
}

/** 获取元素属性 */
async function getElementAttribute(element: ElementHandle, name: string): Promise<unknown> {
  if (!name) {
    throw new Error('get attr requires an attribute name')
  }

  return element.attribute(name)
}

/** 获取元素属性 */
async function getElementProperty(element: ElementHandle, name: string): Promise<unknown> {
  if (!name) {
    throw new Error('get prop requires a property name')
  }

  return element.property(name)
}

/** 获取元素尺寸和偏移 */
async function getElementRect(element: ElementHandle): Promise<{ size: unknown; offset: unknown }> {
  const [size, offset] = await Promise.all([
    element.size(),
    element.offset(),
  ])

  return { size, offset }
}

/** 获取小程序运行时 app config（pages/tabBar/subPackages） */
async function getRuntimeAppConfig(miniProgram: MiniProgram): Promise<{ pages: unknown[]; tabBar: { list: unknown[] }; subPackages: unknown[] }> {
  if (typeof miniProgram.evaluate !== 'function') {
    return {
      pages: [],
      tabBar: { list: [] },
      subPackages: [],
    }
  }

  const result = await miniProgram.evaluate(`function () {
    const config = typeof __wxConfig !== 'undefined' ? __wxConfig : {}
    return {
      pages: Array.isArray(config.pages) ? config.pages : [],
      tabBar: config.tabBar || { list: [] },
      subPackages: Array.isArray(config.subPackages) ? config.subPackages : [],
    }
  }`)

  return (result as { pages: unknown[]; tabBar: { list: unknown[] }; subPackages: unknown[] }) || {
    pages: [],
    tabBar: { list: [] },
    subPackages: [],
  }
}

module.exports = {
  parseCallArguments,
  getCurrentPage,
  getSystemInfo,
  getPageStack,
  callWxMethod,
  changeMiniProgramRoute,
  navigateMiniProgramBack,
  callPageMethod,
  evaluateInMiniProgram,
  callNativeMethod,
  getElementAttribute,
  getElementProperty,
  getElementRect,
  getRuntimeAppConfig,
}
