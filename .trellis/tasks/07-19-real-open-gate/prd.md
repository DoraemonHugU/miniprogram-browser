# PRD：真机 open 门禁

## Goal

可重复验证「能正确 open」：open → path → snapshot；缺环境 skip，环境齐但失败 fail。

## Delivered

- `scripts/real-open-gate.cjs`
- `npm run test:real-open-gate`
- `tests/real-open-gate.test.cjs`（skip 路径）
- AGENTS.md / README 指针

## Acceptance

- [x] 脚本存在；无 env / SKIP → exit 2（单测）
- [x] 默认 `npm test` 不含真机 open（仅 skip 单测）
- [x] 本机执行：exit 1（DevTools cli-server-start-error / 冷启动未 live）——门禁**正确失败**，证明脚本可判定
- [ ] 健康 DevTools 下 exit 0（需人侧重启/登录后复跑）

## Note

「能正确 open」的产品目标 = 门禁绿。当前本机 DevTools automation 不健康时门禁必须红，不能假绿。
