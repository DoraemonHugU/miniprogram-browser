# PRD：冷启动自愈（用户无需二次 open）

## Goal

工具在代码层自动完成：port 已 live 时重连成功、失败不拆掉已 live runtime；使用者不必「短等再 open / 手动 session list」。

## Requirements

- R1: wait-live/connect 失败后，若**本 autoPort 已 live** → 自动 connect-only 成功返回（healed）
- R2: 否则若同项目**其它** live → attach 救援（已有，保留）
- R3: cleanup **仅在救援失败后**执行；若本 port 已 live → 永不 close/清 session
- R4: 单测覆盖同 port heal 与「live 时 skip cleanup」
- R5: 不扩大 scope

## Acceptance

- [ ] 同 port live 时 open 失败路径可自愈成功（单测）
- [ ] live 时 cleanup 不 close
- [ ] build + 相关测试绿
