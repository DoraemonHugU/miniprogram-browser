# Session 模型重构设计

## 核心问题

当前代码把**用户上下文（session）**和**运行时连接（DevTools 窗口）**混为一个对象，autoPort 作为身份键锁死，导致连接失败后无法恢复。

## 现实场景

```
同一项目，多个 DevTools 窗口：

  DevTools 窗口 A        DevTools 窗口 B
  (autoPort=9516)        (autoPort=9517)
      ↑                       ↑
  session "work"          session "debug"
  (project X)             (project X)
  
  → 两个 session 各自独立做 snapshot/click/goto，互不干扰
```

## 设计原则

1. **Session = 用户逻辑上下文**。存路由、refs、日志。不存连接信息。
2. **Runtime = DevTools 窗口**。autoPort 是运行时分配的 TCP 端口，是瞬态资源。
3. **Session 和 Runtime 的关系是动态的**。每次 open/connect 时绑定，session 文件不固化 autoPort。
4. **Runtime 由全局 runtime 池管理**（复用已有的 `runtimeLaunchRecord`），按 projectPath 分组。

## 数据模型

```
SessionState（持久化）        RuntimeRecord（持久化，不绑 session）
├ name: string                ├ autoPort: string
├ projectPath: string  ← 身份  ├ projectPath: string
├ route: string               ├ cliPath: string
├ refs: RefRecord[]           ├ pid: number
├ logs: ConsoleEvent[]        ├ status: 'live'|'starting'|'dead'
└── 没有 autoPort ──          └ startedAt: string
```

## 数据流

### Open/Connect 流程

```
open --session work --project X

1. resolveSession("work")
   → 从磁盘读 session（无 autoPort）
   → 如果不存在，创建空 session
   → bindSessionRuntimeFromPool("work")：按 sessionName 从 runtime 池瞬态回绑

2. findRuntime(X)
   → 从 runtimeLaunchRecords 查 project=X.status=live 的 runtime
   → 同 sessionName 优先；否则同项目唯一 live
   → 如果有 → attach（拿到 autoPort 直接连）
   → 如果无 → 分配新 autoPort → devtools auto → 记录到 runtimeLaunchRecords

3. connect(ws://127.0.0.1:{autoPort})

4. 操作（goto/snapshot/click）
   → 每次命令再次 resolveSession → bindSessionRuntimeFromPool
   → session 更新 route/refs

5. saveSession() ← 只存用户状态，不存 autoPort
```

### Doctor 流程（修复当前问题）

```
doctor --session test-real --project X

1. resolveSession("test-real")
2. findRuntime(X) → 无 live runtime → 分配 autoPort=9516 → devtools auto
3. auto 失败（DevTools appid 未就绪）→ 清理 runtime record
4. session 未受污染（autoPort 不在 session 中）
5. 用户重试 doctor → 分配 autoPort=9517 → 从新开始
```

## 修改范围

### session-store.ts

- `assertBindingConsistency`：keys 从 `['projectPath', 'autoPort']` 改为 `['projectPath']`。autoPort 不参与 session 身份绑定。
- `validateSessionPortConflicts`：保留（冲突检查在端口分配时做，但不再阻止 session 加载）。
- `createEmptySessionState` / `loadSessionState`：config 中不携带 autoPort（或作为瞬态元数据）。
- `ensureSessionPorts`：仅在连接时调用，结果存在 state 的瞬态字段（runtime binding）中，**不保存到 session JSON**。

### miniprogram-browser.ts

- `resolveSession`：移除 `assertBindingConsistency` 对 autoPort 的检查。
- `handleOpen`：从 runtime 池获取 autoPort，不再依赖 session.config.autoPort。
- `handleDoctor`：先做 session resolve（只拿项目路径），再启动 automation，失败时不保存 session。
- `shouldRetryOpenWithAnotherAutoPort`：逻辑不变（已经在用重试机制），但重试时需要从 runtime 池重新分配端口。
- `saveSessionState`：保存前清除 config 中的 autoPort/devtoolsPort 瞬态字段。

### runtime-launch 记录

- 现有的 `RuntimeLaunchRecord` 作为 runtime 池的基础。
- 增加 `findLiveRuntime(projectPath)` 方法。
- 增加 `markRuntimeDead(autoPort)` 方法。

## 向后兼容

- 旧 session 文件中存有 autoPort——加载时忽略该字段，不影响使用。
- `--auto-port` CLI 参数保留为内部调试参数，但不再影响 session 绑定。
