/**
 * miniprogram-automator — 外部依赖类型声明
 *
 * `miniprogram-automator` 没有自带 .d.ts（v0.12.1）。
 * 本文件声明 CLI 实际使用的方法子集。
 * 非标准扩展（`__mpbRuntimeReady` 等）写在扩展接口中。
 */

declare module 'miniprogram-automator' {
  interface ConnectOptions {
    wsEndpoint: string
  }

  interface ScreenshotOptions {
    path: string
  }

  interface Launcher {
    connectTool(options: ConnectOptions): Promise<MiniProgram>
  }

  /** MiniProgram — automation 连接后的运行时句柄 */
  class MiniProgram {
    // —— 标准方法 ——
    on(event: string, callback: (payload: unknown) => void): void
    off(event: string, callback: (payload: unknown) => void): void
    removeListener(event: string, callback: (payload: unknown) => void): void
    send(method: string, params?: Record<string, unknown>): Promise<unknown>
    close(): Promise<void>
    disconnect(): Promise<void>
    screenshot(options: ScreenshotOptions): Promise<void>

    // —— 运行时桥接方法（runtime-bridge 使用） ——
    currentPage(): Promise<PageHandle | null>
    pageStack(): Promise<PageHandle[]>
    systemInfo(): Promise<unknown>
    callWxMethod(method: string, ...args: unknown[]): Promise<unknown>
    callPluginWxMethod?(pluginId: string, method: string, ...args: unknown[]): Promise<unknown>
    evaluate(source: string | (() => unknown)): Promise<unknown>
    native(): Record<string, unknown> | null

    // —— CLI 扩展（运行时注入） ——
    __mpbRuntimeReady?: boolean
    __mpbRuntimeProbe?: unknown
  }

  /** 页面句柄（currentPage / pageStack 返回） */
  interface PageHandle {
    path?: string
    query?: Record<string, unknown>
    callMethod(method: string, ...args: unknown[]): Promise<unknown>
    $(selector: string): Promise<ElementHandle | null>
    $$(selector: string): Promise<ElementHandle[]>
  }

  /** 元素句柄（page.$ / page.$$ 返回） */
  interface ElementHandle {
    attribute(name: string): Promise<unknown>
    property(name: string): Promise<unknown>
    size(): Promise<unknown>
    offset(): Promise<unknown>
    text(): Promise<string>
    $(selector: string): Promise<ElementHandle | null>
    $$(selector: string): Promise<ElementHandle[]>
  }

  /** 主入口 —— 连接或构造 automator */
  function connect(options: ConnectOptions): Promise<MiniProgram>

  /** automator 实例，包含 launcher */
  class Automator {
    launcher: Launcher
  }

  /** 导出 connect 和 Automator 构造 */
  export { Automator, connect, ConnectOptions, Launcher, MiniProgram }
  export default { connect, Automator }
}
