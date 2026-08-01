# P0 Session 连续性与 Runtime 选择

## Goal

修复省略 --session 时缺少稳定当前目标的问题；引入项目级活动 Session，并在多 Runtime 时给出可复制、不可误选的选择提示。

## Requirements

- 在项目级状态中保存一个可恢复的 `activeSession`（活动 Session）指针，不把 `autoPort` 固化到该指针中。
- 显式 `open/connect --session <name>` 成功后更新活动指针；自动生成的 Session 成功打开后也更新活动指针。
- 省略 `--session` 时按以下顺序解析：活动 Session 且 live → 同项目唯一 live Runtime → 生成/复用 `{project}-xN`；活动指针失效且有多个 Runtime 时必须报歧义。
- `MINIPROGRAM_BROWSER_SESSION` 可作为 Agent/工作树级显式默认值；命令行 `--session` 优先级最高。
- 多 Runtime 错误必须提供候选 Session、route、autoPort，以及直接可复制的 `--session`/`--fresh` 命令；不得要求用户手填 `autoPort`。
- 不改变 `--fresh`、attached Session 解绑和 owner Runtime 关闭等现有安全语义。

## Acceptance Criteria

- [ ] 显式打开 `work` 后，省略 `--session` 的命令绑定到 `work`。
- [ ] 活动 Session stale 时不会被当作 live 目标；单一 live Runtime 可以安全回退，多 Runtime 必须报错。
- [ ] 显式 `--session debug` 可以在多 Runtime 中精确命中 `debug`，不受 `updatedAt` 影响。
- [ ] 多 Runtime 文本错误包含至少两条可复制命令，JSON 的 `diagnostics` 包含候选数组和选择原因。
- [ ] 环境默认值不会覆盖显式 `--session`，没有环境变量时行为与旧版兼容。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
