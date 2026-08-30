# Implement：Windows 游客态 automation 诊断

1. [x] 为 `code 10 / 不存在此 AppID` 与 `code 10 / 需要重新登录` 补失败分类测试。
2. [x] 收紧 `runtime-cli-shared.ts` 与 open 启动 hints 中的登录/AppID正则。
3. [x] 为 Tool-only runtime 补事件订阅测试，并禁止其触发 App 级 console/exception 监听。
4. [x] 同步 README、Skill、product/session contracts 的游客态与平台边界。
5. [x] 运行 build、定向 runtime/CLI/文档测试和 `git diff --check`。
6. [x] 只用公开 Demo 复测 Windows gate；App runtime 未 ready，已停止 L0 并保留原始错误。
7. [x] 根据 PR Windows CI 失败补 `cmd.exe / cli.bat` 空格/中文 argv 引用修复，并在独立 F 盘 checkout 复测。
8. [x] 重跑相关回归，追加提交、push，并确认 PR CI 7/7 通过。

Rollback：revert 本 PR；无配置迁移或全局状态回滚。
