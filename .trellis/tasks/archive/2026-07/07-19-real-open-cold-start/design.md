# Design：真机 open 冷启动稳定

## 架构要点

### A. connectOrEnable（R1）

```
live? → connect
allowEnable?
  no → error 先 open
  yes → enable
      → waitUntilLive(autoPort, { deadlineAt, minWaitMs: ENABLE_AUTO_WAIT })
      → still not live → throw clear error (keep raw)
      → connectWithRetry
      → waitForRuntimeReady
```

`waitUntilLive`：poll `isAutomationEndpointLive`，间隔 ~500ms，受 `deadlineAt` 约束。

### B. cleanup（R3）

`cleanupStartedOpenRuntime` 前：

```
sameProjectLive = launches/sessions probe live excluding current launch id
if sameProjectLive.length > 0:
  do NOT closeDevtoolsProject
  mark launch failed/stale
  clear current session only if product still wants
else:
  existing close path
```

### C. attach / auto-port（R4）

- `resolveAttachableRuntime`：除 `live` 外，对同项目 `starting` 也 probe，通则当 live。
- `validateSessionPortConflicts`：若 other 占用同 autoPort **且同 project**，open 路径改为 attach 而非 throw；resolveSession 时若显式 autoPort 同项目，跳过冲突或先 bind。
- 显式 `--auto-port`：`handleOpen` 开头若 port live 且同项目 → connected/attached，不 started 狂 enable。

### D. session 时间（R5/R6）

- `createEmptySessionState`：`createdAt`/`updatedAt` = now ISO
- `prepareSessionStateForSave`：保留 `createdAt`（已有不改），`updatedAt` = now
- `listSessionStates` / `loadOtherSessionConfigs`：透出 `createdAt`/`updatedAt`
- `handleSessionList`：行内 `created=...`；JSON 字段原样；autoPort 从 `listRuntimeLaunches` 按 sessionName 优先回填

### E. 多 session 锁（可选本任务若时间够）

同 project 的 started open 用短锁文件 `locks/__open_project__.lock` 串行；第二等待后 re-resolve attach。优先实现 A–D。

## 文件

- `src/lib/runtime-connect.ts` — waitUntilLive
- `src/miniprogram-browser.ts` — open/cleanup/list/attach
- `src/lib/session-store.ts` — timestamps, list fields, port conflict nuance
- `tests/runtime.test.cjs` / `tests/cli-behavior.test.cjs` / `tests/core.test.cjs`

## 风险

- poll 过长拖慢失败路径 → 受 open `--timeout` 约束
- 不 close 导致僵尸窗 → 仅当探测到其它 live 时跳过 close
- 旧 session 无 createdAt → 显示 `-` 或文件 mtime（实现选 `-` 更简单）
