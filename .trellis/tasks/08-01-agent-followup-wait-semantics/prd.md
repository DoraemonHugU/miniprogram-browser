# P1 操作后状态跟随与等待语义

## Goal

设计并实现可选操作后 snapshot/follow 反馈，并收敛 await、timeout、settle 的 Agent 使用语义。

## Requirements

- 为 `click/fill/goto` 提供可选的操作后状态反馈，不改变默认低噪声输出。
- Agent 可以在一次命令中请求新的 Snapshot（快照）或摘要，避免手动重复调用造成引用过期。
- 重新梳理 `await`、`timeout`、`settle` 的职责，明确固定延时只是兜底，不作为主要同步方式。
- 保持现有 `@eN` 生命周期：动作后产生的新引用必须明确标注为新状态，不能让 Agent 误用旧引用。

## Acceptance Criteria

- [ ] 默认 click/fill/goto 输出保持兼容，不自动打印大段 Snapshot。
- [ ] 提供可选 follow/snapshot-after 模式，返回新的 route/refs 或 Snapshot 路径。
- [ ] `--await` 继续表达业务条件等待，`--timeout` 只表达最长等待时间；固定等待有独立说明。
- [ ] 新模式在 JSON 和文本中都能看出状态来自操作前还是操作后。
- [ ] 补充 stale ref、路由跳转、同页输入三类回归测试。

本任务先完成产品设计和契约，不与 P0 Session 绑定重构同一条解析链；待 P0/P1 状态查询稳定后再实现。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
