# PRD：CLI 行为测试修复与跨平台 open 路径

## Goal

让 `tests/cli-behavior.test.cjs` 在 WSL/Linux 与 Windows 主机语义下**稳定全绿**，并保证：

1. session 管理（list/kill/prune）不依赖「失败 open 残留 session」
2. 假 DevTools CLI 能真实走到 `auto`/`close` 调用链（不被 `node.exe` bundle 校验误杀）
3. open 失败分类（code 17、timeout cleanup、doctor ephemeral）在跨平台仍可测

为后续真机跨平台打磨提供可靠回归网。

## User value

- 改 CLI 后可用 `cli-behavior` 回归 session 与 open 失败路径
- WSL 下 shell/Node 假 CLI 不被「缺 node.exe」挡住
- session list 项目作用域有可重复证据

## Confirmed facts

1. **session list/kill 空列表**：`open` 无 CLI → 失败 → `cleanup.sessionCleared=true` 清掉 mid-open 写入的 session → list 为空。产品「失败 open 清 session」合理；测试假设过时。
2. **code 17 / timeout / prune ENOENT**：假 CLI 是裸 `#!/bin/sh`；WSL 上 `devtoolsHost=win32`，`validateAutomationCliConfig` 要求同目录 `node.exe`，在 spawn 前抛 `CLI bundle is incomplete`，无 `calls.log`。
3. **调用形态**：win32 host 下 `spawnSync(node.exe, [cli.jsWinPath, ...args], { cwd: cliDir })`。
4. **`stripRuntimeFields`**：save 时去掉 autoPort；lock 测试需 load 后回绑或 `recordRuntimeLaunch`。
5. **基线**：`cli-behavior` ~8 pass / 10 fail；runtime/core 已绿。

## Requirements

| ID | 要求 |
|----|------|
| R1 | session list/kill 测试用 `saveSessionState`（等）种子，不依赖失败 open 留文件 |
| R2 | `createFakeDevtoolsCli`：win32 host 提供 `cli.js` + `node.exe` stub，记录 `calls.log` |
| R3 | code 17 / timeout / cleanup / doctor / prune 改用 R2 |
| R4 | 优先改测试；产品校验仅在误伤真实 CLI 时再动 |
| R5 | `cli-behavior` 全绿；不回归 runtime/core |
| R6 | 不做真 DevTools E2E、不改 ASCII、不强制 strict-eslint 全库 |

## Acceptance Criteria

- [x] `node --test tests/cli-behavior.test.cjs` fail=0
- [x] session list 项目过滤 / `--all` / 非项目目录有稳定种子断言
- [x] open code 17：假 CLI 真调用，人话+raw 含 code 17 / QR_PATH
- [x] open timeout：`OPEN_TIMEOUT`；cleanup 可观测（按当前产品语义断言）
- [x] doctor ephemeral / session prune fake 调用链可测
- [x] 产品可见行为无意外变化；否则 skill/contracts 一句

## Out of scope

- 真机 DevTools smoke
- `07-18-15-strict-eslint` 全量
- push/PR

## Open questions

无（优先改测试 + fake helper）。
