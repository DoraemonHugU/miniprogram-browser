# 执行计划

## 阶段 1：goto 路由修复（小改动，1 步）

### 1.1 修复 handleRelaunch 中路由缺少前导 `/`

**文件**：`src/miniprogram-browser.ts` 第 1665、1667 行

**改动**：在传给 `miniProgram.switchTab` 和 `miniProgram.reLaunch` 之前，确保路由以 `/` 开头。

```ts
// 修改前
await (miniProgram.switchTab as ...)(route)
await (miniProgram.reLaunch as ...)(route)

// 修改后
const absoluteRoute = route.startsWith('/') ? route : `/${route}`
await (miniProgram.switchTab as ...)(absoluteRoute)
await (miniProgram.reLaunch as ...)(absoluteRoute)
```

**验证**：
```bash
npm run build
# 离线验证：检查编译不报错
node -e "const r = 'pages/tools/index'; console.log(r.startsWith('/') ? r : '/' + r)"
# 确认 /pages/tools/index
```

---

## 阶段 2：session 模型重构

### 2.0 风险评估

本阶段涉及 3-4 个文件的修改，核心是 `src/lib/session-store.ts` 中的 `assertBindingConsistency`。由于 `handleOpen`、`handleDoctor`、`resolveSession`、`ensureSessionPorts` 等函数依赖该行为，改动时必须逐一确认下游行为。

**回滚点**：改动前 `git tag session-refactor-before` 或 `git stash`

### 2.1 修改 assertBindingConsistency

**文件**：`src/lib/session-store.ts` 第 542-557 行

**改动**：keys 数组中去掉 `'autoPort'`，只保留 `'projectPath'`。

```ts
// 修改前
const keys = ['projectPath', 'autoPort']

// 修改后
const keys = ['projectPath']
```

### 2.2 修改 saveSessionState：不保存运行时瞬态字段

**文件**：`src/lib/session-store.ts`

**改动**：在 `saveSessionState`/`prepareSessionStateForSave` 中清理 autoPort/devtoolsPort。

需要确认 `saveSessionState` 最终的保存路径——它调用 `JSON.stringify(prepared)`。在 `prepareSessionStateForSave` 中或保存前，从 `state.config` 中临时移除 autoPort/devtoolsPort。

### 2.3 修改 resolveSession：不校验 autoPort 一致性

**文件**：`src/miniprogram-browser.ts`

**改动**：`resolveSession` 中移除第 330 行的 `assertBindingConsistency(state.config || {}, explicitOverrides)` 对 autoPort 的依赖。但保留对 projectPath 的检查。

```ts
// 修改前
assertBindingConsistency(state.config || {}, explicitOverrides)

// 修改后
// assertBindingConsistency 只检查 projectPath，autoPort 不参与
// 但这里仍需调用以确保 projectPath 一致性
```

### 2.4 修改 handleDoctor：失败时不保存 session

**文件**：`src/miniprogram-browser.ts`

**改动**：`handleDoctor` 中的 `enableAutomation` 尝试应该发生在 session 持久化之前。如果 automation 失败，不应保存 session。

当前流程（第 1229-1231 行）：
```ts
if (persistSession) {
  await saveSessionState(state)  // ← 先保存了
}
let automationMetadata = null
try {
  automationMetadata = enableAutomation(state.config)
  // ...
```

改为：
```ts
// 先不保存 session
let automationMetadata = null
try {
  automationMetadata = enableAutomation(state.config)
  // ...
}
// automation 成功后再保存
if (persistSession && /* automation ok */) {
  await saveSessionState(state)
}
```

### 2.5 修改 ensureSessionPorts：不对已有 autoPort 做固化

**文件**：`src/lib/session-store.ts`

**改动**：`ensureSessionPorts` 中，如果 session 已有 autoPort 但不存活，应允许重新分配。

### 2.6 修改 handleOpen：从 runtime 池获取 autoPort

**文件**：`src/miniprogram-browser.ts`

**改动**：`handleOpen` 中的 `currentEndpointLive` 检查改为从 runtime 池查。

---

## 验证清单

```bash
npm run build
npm test
# 真实环境（确认不影响现有功能）：
WECHAT_DEVTOOLS_CLI="<devtools-cli>" node dist/miniprogram-browser.js doctor --session test-rebuild --project <synthetic-demo> --trust-project --json
# goto 测试：
node dist/miniprogram-browser.js goto pages/dashboard/index --session test-rebuild
node dist/miniprogram-browser.js goto /pages/dashboard/index --session test-rebuild
```


## 阶段 3：E2E 暴露的闭环补丁（2026-07-19）

### 3.1 resolveSession 从 runtime 池回绑 autoPort
- `bindSessionRuntimeFromPool`：同 sessionName 优先；探测失败标记 stale
- open 成功任意模式都 `ensureLiveRuntimeLaunch`

### 3.2 connectOrEnable 优先复用 live endpoint
- live 时直接 `connectWithRetry`，不再重复 `devtools auto`
- 避免后续 snapshot/goto 把页面重启回首页 / 拖垮会话

## 验证结果（2026-07-19）

```bash
npm run build   # pass
npm test        # 224 pass / 10 fail（与基线一致的 10 个真实环境/会话集成测试）
```

真实 DevTools E2E（公开合成 Demo，session=work）：
- open --auto-port 9530 → mode=started path=pages/dashboard/index
- session JSON：autoPort=None（strip 生效）
- runtime-launches.json：live autoPort=9530 sessionName=work
- snapshot -i / get text @e3 / goto /pages/tools/index / goto pages/dashboard/index / click 工具箱 → 全部通过
- 无前导 `/` 的 goto 正确导航（absoluteRoute 补全）


## 阶段 4：失败回显（人话 + 底层真因）

- `explainDevtoolsFailureRaw`：识别 INVALID_LOGIN / 42001 / AppID 41002 / 未登录
- `parseAutomationCliFailure` / `formatAutomationCliError`：人话 message + 完整 raw
- `emitCliError`：人话与 raw 不同时打印 raw
- `summarizeDevtoolsStartupHints` 增加 login-expired
- open 成功后同 session 旧不同 autoPort live → stale
- 测试：login token / INVALID_LOGIN parse 用例


## 阶段 5：文档对齐

- README：删除 managed-mirror 主叙事；路径策略改为 direct / wsl-mounted-drive / explicit / project-map
- SKILL：session≠runtime、WSL 推荐 /mnt、失败登录说明
- AGENTS：WSL cleanup 去掉 mirror 规则


## 阶段 6：隐式 session 命名 {project}-xN（TDD）

语义：
- 省略 `--session` 时不使用 `default` / agent 名
- 从项目路径推导 slug（leaf 为 miniprogram/weapp 时向上取父级目录名）
- 复用：`sample-store-x1` 已有则继续用最大序号
- `open --fresh` 且未显式 session：分配 `sample-store-x2`...
- 显式 `--session work` 仍最高优先

实现：
- `projectSessionSlug` / `pickAutoProjectSessionName` / `nextAutoProjectSessionName`（session-store）
- `ensureImplicitSessionName`（main 入口）
- open/doctor/protocol/await 不再强制 sessionProvided
- open 成功回显 `session=... (auto-session)`
- help / README / SKILL / session-contracts 同步

测试：core 4 个命名单测全绿；全量 230 pass / 10 fail（基线不变）
