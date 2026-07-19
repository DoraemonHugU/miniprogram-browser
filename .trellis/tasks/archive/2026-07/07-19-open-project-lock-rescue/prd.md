# PRD：项目级 open 串行与超时/救援

## Goal

避免同项目并行 open 双 auto；OPEN_TIMEOUT 不被陈旧 cli-server-start-error 盖掉；wait-live 失败时同项目唯一 live 可救援 attach。

## Requirements

- R1: 同 project started open 串行（`__open_project__` 锁）
- R2: enrich 不覆盖 OPEN_TIMEOUT
- R3: started 失败后非 fresh 可救援 attach 到其它 live port
- R4: 测试 + build 通过

## Acceptance Criteria

- [ ] OPEN_TIMEOUT 不被 hints 覆盖
- [ ] handleOpen 持有项目锁
- [ ] 相关测试通过
