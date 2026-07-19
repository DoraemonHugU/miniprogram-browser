# PRD：L0 真机 E2E 与分支覆盖

## Goal
扩展真机 E2E：主路径 + 多 session attach、goto、snapshot、soft click、logs、page-stack。

## Delivered
- scripts/lib/e2e-harness.cjs
- scripts/l0-e2e.cjs（15 cases）
- scripts/real-open-gate.cjs 复用 harness
- npm run test:l0-e2e / test:e2e
- tests/l0-e2e.test.cjs skip 路径

## Acceptance
- [x] 缺环境 skip（单测）
- [x] 本机 L0 E2E exit 0（15 cases）
- [x] 不并入默认 npm test
