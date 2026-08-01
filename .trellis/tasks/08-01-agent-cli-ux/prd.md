# Agent CLI 使用体验升级

## Goal

围绕 Agent 连续调用、Session 连续性、Runtime 可解释性和状态反馈，参考 Playwright CLI 与 agent-browser 收敛 miniprogram-browser 的产品体验。

## Requirements

- 面向 Agent 的默认调用链应保持低配置：单一 live Runtime 时可以省略 `--session`。
- 显式打开或连接的 Session 应成为当前项目的活动 Session；后续省略 `--session` 时优先继续该活动 Session。
- 多个不同 live Runtime 且没有可用活动 Session 时不得按最新时间猜测目标，必须给出候选和可复制的下一步命令。
- Session 与 Runtime 的关系必须在成功输出和状态查询中可见，至少包含 owner/attachedTo、autoPort、路由和 live 状态。
- 为 Agent 提供一个低成本的状态确认入口：可查询当前活动 Session，也可查询指定 Session，并支持 `--json`。
- 操作后状态跟随和等待语义作为独立 P1 任务设计，不能破坏现有低噪声默认输出。

产品决策：默认选择“活动 Session”，不选择“最新 Runtime”；只有用户意图无法安全推断时才要求显式 `--session`。`autoPort` 继续由 CLI 管理，不升级为用户配置项。

参考对标：Playwright CLI 和 agent-browser 都采用默认 Session + 命名 Session 并行的模型，不把最近启动的 Runtime 作为隐式目标。

## Acceptance Criteria

- [ ] `open --session work` 成功后，后续同项目 `snapshot`、`click`、`path` 等命令可以继续使用 `work`，不需要重复传参。
- [ ] 同项目只有一个 live Runtime 时，省略 `--session` 仍能自动 attach。
- [ ] 同项目存在多个不同 live Runtime 且没有活动 Session 时，CLI 不会静默选择最新 Runtime；文本和 JSON 均提供候选、原因和下一步。
- [ ] `session info`/`status` 能回答当前目标、Runtime owner、attachedTo、live/stale、route、autoPort 等 Agent 需要的状态问题。
- [ ] 旧版 Session registry（会话注册表）和旧版 Session 文件无需迁移即可继续读取。
- [ ] 相关单元测试、帮助文本、SKILL.md 和产品契约保持一致。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
