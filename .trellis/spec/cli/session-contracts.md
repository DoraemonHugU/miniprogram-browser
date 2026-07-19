# CLI Session 契约（code-spec）

> 适用范围：`src/lib/session-store.ts`、`src/miniprogram-browser.ts` 中 resolveSession/handleOpen/handleDoctor 等 session 生命周期函数。
> 维护者：改动 session 身份绑定、端口分配策略、session 持久化字段时，必须同步本文件。

## 1. Scope / Trigger

- 触发：session 是 CLI 的用户工作上下文，管理路由、refs、日志等状态。session 存储与运行时连接的解耦是本契约的核心。
- 背景（已确立事实）：session 曾混用「用户上下文」和「运行时连接」两种不同生命周期的数据，导致 autoPort 被固化在 session 文件中、连接失败后无法恢复。
- 产品原则（必须同时遵守）：
  1. **工具包揽脏活**：trust / 路径转换 / 端口分配 / runtime 复用对用户默认透明；理想路径是 `open <项目>` 即连上。
  2. **成功要有必要信息**：连接成功后回显 `mode` / `path` / `project` / `autoPort` 等操作事实（可观测，不是让用户去配）。
  3. **失败要可定位**：token 过期、AppID 缺失等工具无法自动修复的问题，用清楚人话说明情况，并保留/抛出底层真实异常（DevTools/CLI/automator 原文，挂在 `raw` / 终端二次输出）。不强制自造 `code` 或 `next action`；禁止用本项目包装异常盖掉根因。
     - 实现落点：`explainDevtoolsFailureRaw` / `parseAutomationCliFailure`（`src/lib/runtime-cli-shared.ts`）；`emitCliError` 在人话与 raw 不同时打印 raw。

## 2. 数据模型

### SessionState（持久化）

```ts
interface SessionState {
  name: string                // 用户命名
  projectPath: string         // 小程序项目路径（身份键）
  route: string               // 当前路由
  refs: RefRecord[]           // @eN 引用
  logs: ConsoleEvent[]        // 控制台输出
  exceptions: ExceptionEvent[] // 异常记录
  // — 不含 autoPort、devtoolsPort 等运行时字段 —
}
```

### RuntimeRecord（持久化，独立文件）

```ts
interface RuntimeLaunchRecord {
  id: string                  // 唯一 ID
  sessionName: string
  projectPath: string
  cliPath: string
  autoPort: string            // TCP 端口，运行时资源
  devtoolsPort: string
  status: 'live' | 'starting' | 'dead' | 'stale'
  createdAt: string
  updatedAt: string
}
```

### 身份绑定

```ts
// session 身份由 {sessionName, projectPath} 唯一确定
// autoPort 不参与身份绑定
const ASSERTION_KEYS = ['projectPath']
```

### 隐式 session 命名（省略 --session）

```ts
// 不使用 default / agent 名
// 基于项目路径 slug + 序号：
//   earlyRiser/apps/miniprogram → earlyriser-x1
// 复用：已有最大 earlyriser-xN
// 新开：open --fresh 且未显式 session → earlyriser-x{N+1}
projectSessionSlug(projectPath)
pickAutoProjectSessionName(existingNames, projectPath)
nextAutoProjectSessionName(existingNames, projectPath)
```

## 3. Contracts

### 3.1 Session 生命周期

```
open --session work --project X

1. resolveSession("work")
   → 磁盘读取 session（可能不存在 → 创建空 session）
   → stripRuntimeFields() 清理旧文件残留的运行时字段
   → bindSessionRuntimeFromPool()：按 sessionName/project 从 runtime 池瞬态回绑 autoPort
     （优先同 sessionName live；否则同项目唯一 live）
   → ensureSessionPorts()：仅在仍无 autoPort 时分配新端口

2. findRuntime(X)  [open 路径]
   → 查 RuntimeLaunchRecord: project=X, status=live
   ├─ 有（同 session 优先） → attach（拿到 autoPort 直接连 WebSocket）
   └─ 无 → assignPorts() 分配新 autoPort → devtools auto → 记 runtime record

3. connect(ws://127.0.0.1:{autoPort})

4. 操作（goto/snapshot/click）
   → 每次命令再次走 resolveSession → bindSessionRuntimeFromPool
   → 因此后续命令不再依赖 session JSON 中的 autoPort

5. saveSessionState() → stripRuntimeFields() → 只存用户状态
```

### 3.1.1 后续命令的 runtime 回绑（关键契约）

session 文件**不**存 autoPort。`snapshot` / `click` / `goto` 等命令必须在 `resolveSession` 中：

1. 按 sessionName/project 从 runtime 池取候选 live launches
2. 对候选做 `isAutomationEndpointLive`；失败标记 `stale` 并试下一个
3. 成功则把 `autoPort` 写到**内存态** `state.config`（不落盘）
4. 失败才让 `ensureSessionPorts` 分配新端口

```ts
// Wrong：后续命令只 ensureSessionPorts → 重新拿到空闲端口 9517，连不到 open 时的 9521
await ensureSessionPorts(state)

// Correct：先从 runtime 池回绑
await bindSessionRuntimeFromPool(state)  // work → autoPort=9521
await ensureSessionPorts(state)          // 已有 autoPort 则跳过分配
```

### 3.1.2 connectOrEnable 必须优先复用 live endpoint

`withMiniProgram` → `connectOrEnable`：

1. 若 `config.autoPort` 已有且 endpoint live → **直接 connect**，不要再跑 `devtools auto`
2. 否则：
   - **`allowEnable=true`**（仅 `open` / `connect` 经 `connectOpenSession` 传入；`forceEnable` 同理）→ `enableAutomation` → wait → connect
   - **默认 `allowEnable=false`**（`snapshot` / `click` / `goto` 等）→ **抛错要求先 open**，禁止无脑全量 `devtools auto --debug`

重复 `auto` 会重启小程序（路由回首页），并可能打断已有 automation 会话；失败后再 snapshot 刷 auto 还会制造 AppID 假阳性与日志噪音。

### 3.1.4 open 冷启动时序与 cleanup

- enable 后必须在 open deadline 内 **poll live** 再 connect（`waitUntilAutomationLive`），禁止只靠固定 sleep。
- started 失败 cleanup：若同项目仍有其它 live runtime，**禁止** `close` 项目窗（`skippedCloseReason=shared-live-runtime`）。
- session 文件持久化 `createdAt`/`updatedAt`；`session list` 展示创建时间，autoPort 尽量从 runtime 池回显。
- 同项目 `open` 串行：`locks/__open_project__.lock`，避免双 auto。
- `OPEN_TIMEOUT` 不被 WeappLog 的 `cli-server-start-error` 覆盖 code。
- started 失败后非 `--fresh` 可救援 attach 到同项目其它 live port。
- 冷启动失败自愈（在 cleanup 之前）：① 本 `autoPort` 已 live → connect-only 成功；② 同项目其它 live → attach；仅自愈失败才 close/清 session。
- wait-live 预算耗尽后仍做一次 late live 探测，减少边界竞态导致的假失败。




```ts
// Wrong：业务命令默认 enable
await connectOrEnable(config) // 旧行为：非 live 就 auto

// Correct
// open/connect:
await withMiniProgram(state, task, { allowEnable: true, ... })
// snapshot/click:
await withMiniProgram(state, task) // allowEnable 默认 false
```

### 3.1.3 DevTools raw 分类与启动 hints

- `Fetching AppID () permissions` **不是** AppID 失败信号；成功 auto 也会打印。真失败看 `41002` / `appid missing` 等。
- open 失败 diagnostics 的 WeappLog hints 应 **时间过滤**（默认近 10 分钟 mtime），避免陈旧 41002 挂到本次失败。

### 3.2 持久化过滤

保存 session 时，`prepareSessionStateForSave` 内部调用 `stripRuntimeFields` 清理：

```ts
function stripRuntimeFields(config: AnyRecord): AnyRecord {
  const cleaned = { ...config }
  delete cleaned.autoPort
  delete cleaned.devtoolsPort
  delete cleaned.devtoolsProjectAutoLink
  delete cleaned.devtoolsProjectMirror
  return cleaned
}
```

加载旧 session 文件时同样调用 `stripRuntimeFields`，忽略残留运行时字段。

### 3.3 goto 路由规范

`handleRelaunch` 中调用 `miniProgram.reLaunch` / `miniProgram.switchTab` 前必须补 `/`：

```ts
const absoluteRoute = route.startsWith('/') ? route : `/${route}`
```

无 `/` 前缀时 DevTools automation 协议会按**相对路径**处理，从当前页面拼接。

### 3.4 doctor 失败不污染 session

`handleDoctor` 中 session 保存时机在 `enableAutomation` + `probeAutomationRuntime` 成功之后：

```ts
// 修改后
let automationMetadata // ... 执行 automation
let probe // ... probe runtime
if (persistSession && probe && probe.connected) {
  await saveSessionState(state)  // 只在连通时保存
}
```

### 3.5 Session 锁定

session 的 `assertBindingConsistency` 只检查 `projectPath`：

```ts
function assertBindingConsistency(existingConfig, overrides) {
  const keys = ['projectPath']  // 不含 autoPort
  for (const key of keys) {
    const existingValue = String(existingConfig[key] || '').trim()
    const overrideValue = String(overrides[key] || '').trim()
    if (existingValue && overrideValue && existingValue !== overrideValue) {
      throw new Error(`Session is already bound to ${key}=${existingValue}`)
    }
  }
}
```

autoPort 冲突检查在运行时分配时由 `validateSessionPortConflicts` 处理，不阻止 session 加载。

## 4. Validation & Error Matrix

| 条件 | 结果 |
|------|------|
| `projectPath` 与已绑定 session 冲突 | `assertBindingConsistency` 抛出，阻断 |
| `autoPort` 与已绑定 session 冲突 | 不抛出（autoPort 不参与身份绑定），运行时端口分配器处理 |
| doctor 时 automation 失败 | session 不保存，下次重试自动分配新端口 |
| 旧 session 文件含 autoPort | `loadSessionState` 通过 `stripRuntimeFields` 忽略 |
| goto 输入无前导 `/` | 自动补 `/`，发给 DevTools 前已标准化为绝对路径 |

## 5. Good / Base / Bad Cases

- **Good**: 同一项目创建 `session "work"`（port 9516）和 `session "debug"`（port 9517），各自独立 snapshot/click/goto
- **Good**: doctor 因 DevTools 时序失败后，session 文件无 autoPort 残留，下次重试自动分配新端口
- **Base**: `goto pages/dashboard/index` 和 `goto /pages/dashboard/index` 均正确导航到 dashboard
- **Bad**: session 存储中固化 autoPort，导致连接失败后锁死无法重试（旧行为）
- **Bad**: `goto pages/tools/index` 因缺少 `/` 被拼接成 `pages/dashboard/pages/tools/index`（旧行为）

## 6. Tests Required

- `tests/core.test.cjs`:
  - `assertBindingConsistency`：不同 `projectPath` → throws；不同 `autoPort` 但相同 `projectPath` → `doesNotThrow`
  - `prepareSessionStateForSave`：保存后的 `config` 中不含 `autoPort`/`devtoolsPort`
  - `loadSessionState`：从含 autoPort 的旧 JSON 加载后，内存中 `config.autoPort` 为空
  - `stripRuntimeFields`：输入含运行时字段的输出不含这些字段
  - `selectAttachableRuntimeSession`：多 live 时无 preferred → ambiguous；有 preferred sessionName → attach 到同名
  - `selectRuntimeLaunchForSession`：同 sessionName 优先；无同名时仅同项目唯一 live 可回绑；多 live 且无同名 → null

## 7. Wrong vs Correct

#### Wrong
```ts
// autoPort 作为 session 身份键
const keys = ['projectPath', 'autoPort']

// session 保存时保留 autoPort
await saveSessionState(state)  // session JSON 含 autoPort

// doctor 在 automation 前保存 session
if (persistSession) {
  await saveSessionState(state)  // 失败时 session 已被污染
}
let automationMetadata

// 后续命令不回绑 runtime，直接重新分配端口
await ensureSessionPorts(state)  // 拿到空闲 9517，连不到 open 时的 9521

// 后续命令每次强制 enableAutomation
await enableAutomation(config)   // 重启小程序，路由回首页
await connectWithRetry(config)
```

#### Correct
```ts
// autoPort 不从属 session 绑定
const keys = ['projectPath']

// session 保存时清理运行时字段
config: stripRuntimeFields(state.config)

// doctor 在 automation 成功后保存
if (persistSession && probe && probe.connected) {
  await saveSessionState(state)
}

// 后续命令先从 runtime 池按 sessionName 回绑
await bindSessionRuntimeFromPool(state)
await ensureSessionPorts(state)

// live endpoint 直接 connect
if (await isAutomationEndpointLive(config)) {
  return connectWithRetry(config)
}
await enableAutomation(config)
```
