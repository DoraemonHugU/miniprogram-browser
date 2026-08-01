# P1 Session 状态与 Agent 诊断入口

## Goal

增加 session info/status，清晰展示活动 Session、Runtime owner/attachedTo、live 状态、路由和端口，改善 Agent 的状态确认。

## Requirements

- 增加 `session info [<name>]`，并提供 `status` 作为面向 Agent 的短别名。
- 不传名称时查询当前活动 Session；没有活动 Session 时给出明确的项目/候选状态，而不是创建新 Session。
- 输出至少包含：session、active、status、project、route、autoPort、devtoolsPort、runtime mode、owner/attachedTo、created/updated。
- 文本输出适合快速扫描，JSON 输出保持稳定字段名；查询不得关闭 Runtime、分配新端口或修改 Session。
- 默认按当前项目隔离，`--all` 继续作为全局查看的显式逃逸口。

## Acceptance Criteria

- [ ] `session info` 可以在同一项目中显示当前活动 Session 及其 Runtime 状态。
- [ ] `session info work` 可以查询指定 Session；不存在时返回稳定错误 code 和候选建议。
- [ ] `status --json` 不产生进度噪音，包含可供 Agent 直接判断的结构化字段。
- [ ] attached Session 显示 `attachedTo`/owner，不把共享 Runtime 误报为 dedicated。
- [ ] 查询路径不写入活动指针、不分配 autoPort、不改变运行状态。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
