# Session 模型重构 + goto 路由修复

## 背景

真实环境测试发现两个独立缺陷：

### 问题 A：goto 路由缺少前导 `/`

- 现象：`goto pages/tools/index` 报错 `page "pages/dashboard/pages/tools/index" is not found`
- 根因：`handleRelaunch`（`src/miniprogram-browser.ts:1667`）把用户输入直接传给 `miniProgram.reLaunch()`，未补 `/`。DevTools automation 协议将无 `/` 路由解析为相对路径，从当前页面 `pages/dashboard/index` 拼接出不存在路径。
- 修复范围：`handleRelaunch` 中 `reLaunch`/`switchTab` 调用点（第 1665、1667 行）

### 问题 B：session 的 autoPort 固化锁定

- 现象：`doctor` 因 DevTools 时序失败后 session 锁死 port；换端口重试被拒绝。
- 根因：`assertBindingConsistency`（`src/lib/session-store.ts:542`）将 `autoPort` 作为 session 身份键，但 autoPort 是运行时瞬态资源，不是身份一部分。

## 现实场景

```
同一项目，多个 DevTools 窗口：

  DevTools 窗口 A        DevTools 窗口 B
  (autoPort=9516)        (autoPort=9517)
      ↑                       ↑
  session "work"          session "debug"
  (project X,路由/refs)   (project X,路由/refs)
  
  → 两个 session 各自独立操作，互不干扰
  → session 不固化 autoPort，断开后可重连到新窗口
```

## Requirements

- [R1] goto 路由修复：用户输入 `goto pages/tools/index` 或 `goto /pages/tools/index` 均能正确导航
- [R2] session 身份只绑定 `{sessionName, projectPath}`，不绑定 autoPort
- [R3] 故障恢复：automation 失败后 session 不会被锁在旧端口上
- [R4] 多窗口支持：同一项目可启动多个 DevTools 窗口，各 session attach 到不同窗口

## Acceptance Criteria

- [ ] AC1: `goto pages/dashboard/index` 和 `goto /pages/dashboard/index` 均正确跳转到 dashboard
- [ ] AC2: automation 失败后，session 不固化端口；重试自动分配新端口
- [ ] AC3: 同一项目可存在 `session "work"`（autoPort=9516）和 `session "debug"`（autoPort=9517），同时各自独立操作
- [ ] AC4: session JSON 文件中不含 autoPort 字段（或加载时忽略）
- [ ] AC5: `--fresh` 启动的 DevTools 窗口不会与已有 session 冲突

## Out of Scope

- 不修改 DevTools CLI 自身的时序问题（auto 调用时 appid 未就绪是 DevTools 内部行为）
- 不引入后台守护进程或长连接保活
