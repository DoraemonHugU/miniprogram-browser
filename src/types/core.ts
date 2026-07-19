/**
 * core.ts — 核心类型接口
 *
 * 本文件定义项目中跨模块共享的核心类型：
 * - CliConfig：CLI 配置对象
 * - SessionState：session 运行时状态
 * - MiniProgram：外部 automation 库句柄
 * - 相关辅助类型
 */

// ============================================================
// CliConfig — CLI 配置（扁平键值对，由调用方传入）
// ============================================================

/** 单个端口分配结果 */
interface PortResolution {
  devtoolsPort: string
  autoPort: string
  devtoolsPortAssigned: boolean
  autoPortAssigned: boolean
}

/** CLI 配置对象。各字段由 config / metadata 合并而来。 */
interface CliConfig {
  projectPath: string
  autoPort: string
  devtoolsPort?: string
  cliPath?: string
  sessionDir: string
  screenshotDir: string
  tempScreenshotDir: string
  /** 旧版 session 目录路径（端口迁移前） */
  legacySessionDir?: string
  /** DevTools 项目路径覆盖 */
  devtoolsProjectPath?: string
  /** 项目路径映射表（linux=windows） */
  devtoolsProjectMap?: string
  /** 自动链接标记 */
  devtoolsProjectAutoLink?: string
  /** 镜像标记 */
  devtoolsProjectMirror?: string
  /** 交互式选择器 */
  interactiveSelectors?: string
  /** git 仓库根目录 */
  repoRoot?: string
}

// ============================================================
// RuntimeEvent — 运行时事件
// ============================================================

/** 运行时事件（console / exception） */
interface RuntimeEvent {
  type: string
  message: string
  timestamp: number
  stack?: string
  [key: string]: unknown
}

/** 路由事件 */
interface RouteEvent {
  from: string
  to: string
  method: string
  timestamp: number
  [key: string]: unknown
}

/** 引用记录 */
interface RefRecord {
  ref: string
  epoch: number
  route: string
  stableKey: string | null
  parentRef: string | null
  scopeRef: string | null
  strategy: {
    kind: string
    value: string
    selector: string
    index: number
  }
  registryId: string | null
  testid: string | null
  businessKey: string | null
  scopeKey: string | null
  selector: string | null
  kind: string
  text: string
  signature: string
}

// ============================================================
// SessionState — session 运行时状态
// ============================================================

/** Session 状态对象。由 createEmptySessionState 初始化，后续动态补充。 */
interface SessionState {
  name: string
  bound: boolean
  config: CliConfig
  route: string
  epoch: number
  nextRefIndex: number
  refs: Record<string, RefRecord | undefined>
  stableKeyToRef: Record<string, string>
  lastSnapshot: unknown[]
  consoleEvents: RuntimeEvent[]
  exceptionEvents: RuntimeEvent[]
  routeEvents: RouteEvent[]
  lastRouteEventSeq: number
  lastVisualProbe: unknown
  pendingVisualAction: unknown
  /** 端口分配信息（运行时设置） */
  portResolution?: PortResolution
  /** runtime 是否已附加（运行时设置） */
  runtimeAttached?: boolean
  /** runtime launch ID（运行时设置） */
  runtimeLaunchId?: string
  /** owner session（运行时设置） */
  runtimeOwnerSession?: string
  /** 附加时间戳（运行时设置） */
  runtimeAttachedAt?: number
  /** launch 状态（运行时设置） */
  runtimeLaunchStatus?: string
  /** 时间戳（簿记） */
  ts?: number
}

// ============================================================
// MiniProgram — 外部库类型（重导出使引用统一）
// ============================================================

/**
 * MiniProgram 是 miniprogram-automator 连接后的运行时句柄。
 * 类型定义见 `miniprogram-automator.d.ts`。
 * 此处仅作重导出，避免各文件直接 import 'miniprogram-automator'。
 */
export type { MiniProgram } from 'miniprogram-automator'

// ============================================================
// 广义 options / 透传
// ============================================================

/** 通用 options 参数袋——用于只读且字段可选的场景 */
interface ReadonlyOptions {
  [key: string]: unknown
}

// ============================================================
// 导出
// ============================================================

export type {
  CliConfig,
  PortResolution,
  ReadonlyOptions,
  RefRecord,
  RouteEvent,
  RuntimeEvent,
  SessionState,
}
