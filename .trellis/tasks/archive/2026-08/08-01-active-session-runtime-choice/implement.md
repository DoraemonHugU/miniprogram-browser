# 实施计划

1. 扩展 `session-store`，增加项目级活动 Session 读写与清理函数，并导出测试入口。
2. 修改隐式 Session 解析，支持环境默认值和活动 Session；保持无项目路径时的现有报错。
3. 在 `open/connect` 成功路径更新活动指针，避免在普通操作命令中更新。
4. 丰富多 Runtime 文本/JSON 诊断，提供可复制的 Session 和 `--fresh` 命令。
5. 更新 Session 契约、CLI help、README/SKILL，并添加解析、兼容和错误输出测试。
6. 验证：`npm run build`；定向 `node --test tests/core.test.cjs tests/help.test.cjs tests/skill-docs.test.cjs`；必要时跑完整 Node 测试并记录已有失败。

回滚点：活动指针只新增状态文件；若真实环境出现异常，可删除该文件或关闭环境默认值，旧的 Runtime 选择路径仍可工作。
