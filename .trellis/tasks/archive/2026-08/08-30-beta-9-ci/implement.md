# 实施计划

1. 固化发布目标
   - 同步根 manifest 为 `0.1.0-beta.9`，确认 Demo 版本不变。
   - 验证：Node 读取 package/lock 版本完全一致。

2. 增加托管跨平台 CI
   - 添加 macOS/Windows/Ubuntu × Node 22/24 matrix。
   - 添加单独 quality/demo job。
   - 验证：YAML 解析、实际命令与 package scripts 对应。

3. 生成发布说明
   - 从 npm 已发布 beta.8 对应 commit 到当前候选的净行为编写。
   - 验证：不包含本机/生产信息，可直接用于 tag 和 prerelease。

4. Mac 完整门禁
   - 默认四项门禁、三框架构建、skill 校验和 pack 内容检查。
   - 真实 DevTools 门禁只指向公开 Demo。
   - 验证：记录 pass/skip/fail，清理临时 session。

5. 整理发布候选
   - 检查 diff、敏感路径、版本和任务上下文。
   - 本轮停在可审核的未提交准备状态，不执行外部发布操作。
