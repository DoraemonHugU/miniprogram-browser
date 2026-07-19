# PRD：真机 open 冷启动稳定 + multi-session + session list 创建时间

## Goal

让 WSL/真机上的 `open` **多数情况下一次成功或可恢复**；多 session 共享/新开互不踩踏；`session list` 能看清每个 session **何时创建**。

## User value

- 冷启动少「auto 已起但 3s 后 connect 失败又关窗」
- 第二 session 默认 attach 唯一 live；`--fresh` 失败不误杀第一路
- `session list` 显示创建时间 + 尽量显示 autoPort

## Confirmed facts

1. enable 可成功；固定 3s 后 connect 常失败；稍后同 port live+appReady。
2. attach 只认 registry live；失败 cleanup 删 launch → 看不见 orphan。
3. 失败 close 是项目级，可误杀共享实例。
4. `--auto-port` 撞绑定抛错，不 attach。
5. session 无 createdAt；list 不显示时间。

## Requirements

| ID | 要求 |
|----|------|
| R1 | enable 后 deadline 内 poll live 再 connect |
| R2 | 本 port 已 live 优先保留 runtime，避免无脑 close |
| R3 | 同项目仍有其它 live 时 cleanup 禁止 close 项目窗 |
| R4 | 唯一 live attach；多 live 冲突；同项目 `--auto-port` live → attach |
| R5 | session 持久化 createdAt/updatedAt |
| R6 | session list 文本+JSON 含 createdAt；autoPort 尽量从 launch 回显 |
| R7 | 单测 + 尽力真机 smoke |
| R8 | 不扩 ASCII / strict-eslint / 永久 @e |

## Acceptance Criteria

- [ ] live 延迟出现时 open 仍可 connect（单测）
- [ ] 同项目另有 live 时失败 cleanup 不 close 项目（单测）
- [ ] 新 session list 含 createdAt
- [ ] 旧 session 无字段不崩
- [ ] build + 相关测试通过

## Out of scope

全端口扫描；snapshot 默认 rescue；push/PR
