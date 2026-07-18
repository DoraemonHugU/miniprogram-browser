/**
 * runtime-bridge.ts — 小程序原生桥接函数
 *
 * 本模块包含直接调用 miniProgram/page API 的轻量桥接函数。
 * 所有函数为纯"转发"操作，不涉及状态管理和复杂逻辑。
 */

type AnyRecord = Record<string, any>

/** 解析原始参数列表：尝试 JSON.parse，保留 undefined */
function parseCallArguments(rawArgs) {
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
async function getCurrentPage(miniProgram) {
  const page = await miniProgram.currentPage()
  if (!page) {
    throw new Error('No current page')
  }
  return page
}

/** 获取系统信息 */
async function getSystemInfo(miniProgram) {
  return miniProgram.systemInfo()
}

/** 获取页面栈 */
async function getPageStack(miniProgram) {
  const stack = await miniProgram.pageStack()
  return (stack || []).map((page) => ({
    path: page.path,
    query: page.query,
  }))
}

/** 调用 wx 方法 */
async function callWxMethod(miniProgram, method, rawArgs = []) {
  return miniProgram.callWxMethod(method, ...parseCallArguments(rawArgs))
}

/** 调用页面方法 */
async function callPageMethod(page, method, rawArgs = []) {
  return page.callMethod(method, ...parseCallArguments(rawArgs))
}

/** 在小程序中执行 JS */
async function evaluateInMiniProgram(miniProgram, source) {
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
async function callNativeMethod(miniProgram, method, rawArgs = []) {
  if (!method) {
    throw new Error('native requires a method name')
  }

  const native = miniProgram.native()
  const handler = native && native[method]
  if (typeof handler !== 'function') {
    throw new Error(`Unknown native method: ${method}`)
  }

  return handler.apply(native, parseCallArguments(rawArgs))
}

/** 获取元素属性 */
async function getElementAttribute(element, name) {
  if (!name) {
    throw new Error('get attr requires an attribute name')
  }

  return element.attribute(name)
}

/** 获取元素属性 */
async function getElementProperty(element, name) {
  if (!name) {
    throw new Error('get prop requires a property name')
  }

  return element.property(name)
}

/** 获取元素尺寸和偏移 */
async function getElementRect(element) {
  const [size, offset] = await Promise.all([
    element.size(),
    element.offset(),
  ])

  return { size, offset }
}

/** 获取小程序运行时 app config（pages/tabBar/subPackages） */
async function getRuntimeAppConfig(miniProgram) {
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

  return result || {
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
  callPageMethod,
  evaluateInMiniProgram,
  callNativeMethod,
  getElementAttribute,
  getElementProperty,
  getElementRect,
  getRuntimeAppConfig,
}
