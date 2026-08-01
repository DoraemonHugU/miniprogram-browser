# 实施计划

1. 对照 Playwright CLI 的操作后 Snapshot 和 agent-browser 的 refs 工作流，确定 `--follow`/`--snapshot-after` 的最终命名。
2. 抽取 settle wait 与业务 await，修正文档和帮助中的含义。
3. 实现 click/fill/goto 的可选后状态反馈，补 JSON/文本回归测试。
4. 在真实 DevTools L0 流程验证跳转、同页输入和 stale ref。
