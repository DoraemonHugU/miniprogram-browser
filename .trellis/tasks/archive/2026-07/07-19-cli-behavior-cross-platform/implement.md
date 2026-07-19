# Implement：CLI 行为测试修复与跨平台 open 路径

## 顺序

1. 实现 `createFakeDevtoolsCli` / `seedSession` helper（`tests/cli-behavior.test.cjs` 或 `tests/helpers/`）
2. 改 session list/kill 种子（R1）
3. 改 code17 / timeout / cleanup / doctor / prune 用 fake helper（R2/R3）
4. 跑 `cli-behavior` 全套；按失败调整 close 路径断言
5. 抽检 runtime；必要时一句 skill/contracts
6. `task.py start` 后实现；完成 check → commit

## 风险

- `stripRuntimeFields` 与 lock 测试 autoPort
- WSL close 路径 `missing-devtools-project-path`
- fake `node.exe` 权限

## Rollback

还原 `tests/cli-behavior.test.cjs`（及若动了的 `runtime-cli.ts`）。
