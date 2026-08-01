# 实施计划

1. 在 `session-store` 增加只读活动 Session 查询，并复用既有项目状态和 Runtime binding。
2. 在 CLI 主路由增加 `session info/status`，实现当前项目/指定 Session 两种入口。
3. 统一文本与 JSON 字段，补充不存在 Session、无活动 Session、attached Runtime 三类测试。
4. 更新 help、SKILL 和 Session 契约。
5. 验证：构建、help/core/skill-docs 定向测试。
