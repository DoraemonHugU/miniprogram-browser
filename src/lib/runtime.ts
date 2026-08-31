/**
 * runtime.ts — 拆包后的统一入口
 *
 * 本文件仅负责从各专注子模块导入并集中导出。
 * 所有函数体已迁移到 src/lib/runtime-*.ts 中。
 */

const {
  buildAutomationArgs,
  shouldOpenProjectBeforeAutomation,
  validateAutomationCliConfig,
  closeDevtoolsProject,
  enableAutomation,
} = require('./runtime-cli')
const {
  collectDevtoolsLogs,
  resolveDevtoolsLogRoot,
} = require('./runtime-logs')
const {
  formatAutomationCliError,
  explainDevtoolsFailureRaw,
  parseAutomationCliFailure,
  summarizeDevtoolsCliRaw,
  hasAutomationCliSuccessSignal,
  detectAutomationCliProgressTimeout,
  parseResolvedIdePort,
} = require('./runtime-cli-shared')
const {
  formatRuntimeEventLines,
  formatConsoleEventLine,
  formatExceptionEventLine,
  formatRouteTimelineLine,
  buildClickNotices,
} = require('./runtime-core')
const {
  readRuntimeTree,
  applySnapshotOptions,
  subtreeForScope,
} = require('./runtime-snapshot')
const {
  ensureNextRefIndex,
  isRefToken,
  getStoredRuntimeEvents,
  clearStoredRuntimeEvents,
  getStoredRouteTimeline,
  clearStoredRouteTimeline,
  syncCurrentRoute,
} = require('./runtime-state')
const {
  sleep,
  normalizeAwaitCondition,
  resolveAwaitTimeoutMs,
  buildNativeDiagnostic,
  waitForMiniProgramStable,
  waitForMiniProgramCondition,
  readRuntimeChangeSignature,
} = require('./runtime-wait')
const {
  getCurrentPage,
  getSystemInfo,
  getPageStack,
  getRuntimeAppConfig,
  callWxMethod,
  changeMiniProgramRoute,
  navigateMiniProgramBack,
  callPageMethod,
  evaluateInMiniProgram,
  callNativeMethod,
  getElementAttribute,
  getElementProperty,
  getElementRect,
} = require('./runtime-bridge')
const {
  normalizeActionDirection,
  normalizeActionDistance,
  performPageScroll,
  performElementScroll,
  performElementSwipe,
  navigateBackWithFallback,
} = require('./runtime-actions')
const {
  ensureRouteTimelineMonitor,
  syncRouteTimelineEvents,
} = require('./runtime-timeline')
const {
  resolveRecord,
  resolveTarget,
  resolveActionTarget,
  snapshotInteractive,
  queryRecords,
} = require('./runtime-resolve')
const {
  withTimeout,
  captureScreenshotToPath,
  cleanupMiniProgram,
  shutdownMiniProgram,
  connectWithRetry,
  isAutomationEndpointLive,
  discoverLiveAutomationPort,
  probeAutomationRuntime,
  sendAutomationProtocol,
  connectOrEnable,
  withMiniProgram,
  confirmRouteAfterAction,
  waitForRuntimeReady,
} = require('./runtime-connect')

module.exports = {
  // ---- runtime-wait ----
  sleep,
  normalizeAwaitCondition,
  resolveAwaitTimeoutMs,
  buildNativeDiagnostic,
  waitForMiniProgramStable,
  waitForMiniProgramCondition,
  readRuntimeChangeSignature,
  // ---- runtime-actions ----
  normalizeActionDirection,
  normalizeActionDistance,
  performPageScroll,
  performElementScroll,
  performElementSwipe,
  navigateBackWithFallback,
  // ---- runtime-connect ----
  withMiniProgram,
  withTimeout,
  captureScreenshotToPath,
  cleanupMiniProgram,
  shutdownMiniProgram,
  confirmRouteAfterAction,
  connectWithRetry,
  isAutomationEndpointLive,
  discoverLiveAutomationPort,
  connectOrEnable,
  probeAutomationRuntime,
  sendAutomationProtocol,
  waitForRuntimeReady,
  // ---- runtime-bridge ----
  getCurrentPage,
  getSystemInfo,
  getRuntimeAppConfig,
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
  // ---- runtime-timeline ----
  ensureRouteTimelineMonitor,
  syncRouteTimelineEvents,
  // ---- runtime-state ----
  getStoredRouteTimeline,
  clearStoredRouteTimeline,
  syncCurrentRoute,
  getStoredRuntimeEvents,
  clearStoredRuntimeEvents,
  ensureNextRefIndex,
  // ---- runtime-core ----
  formatRuntimeEventLines,
  formatRouteTimelineLine,
  buildClickNotices,
  formatConsoleEventLine,
  formatExceptionEventLine,
  // ---- runtime-cli-shared ----
  formatAutomationCliError,
  explainDevtoolsFailureRaw,
  parseAutomationCliFailure,
  summarizeDevtoolsCliRaw,
  hasAutomationCliSuccessSignal,
  detectAutomationCliProgressTimeout,
  parseResolvedIdePort,
  // ---- runtime-cli ----
  validateAutomationCliConfig,
  enableAutomation,
  closeDevtoolsProject,
  buildAutomationArgs,
  shouldOpenProjectBeforeAutomation,
  // ---- runtime-snapshot ----
  readRuntimeTree,
  applySnapshotOptions,
  subtreeForScope,
  // ---- runtime-resolve ----
  isRefToken,
  resolveRecord,
  resolveTarget,
  resolveActionTarget,
  snapshotInteractive,
  queryRecords,
  // ---- runtime-logs ----
  collectDevtoolsLogs,
  resolveDevtoolsLogRoot,
}
