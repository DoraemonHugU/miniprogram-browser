# 实施计划

1. 固化回归测试
   - `await ref` 存在/超时与循环依赖。
   - checkbox/radio label 点击、snapshot 文本降噪。
   - 新命令 parser/help/dispatch 和等待 `change` 的边界。
   - 验证：相关 `node --test` 先失败于目标行为。

2. 修复既有行为
   - `runtime-wait` 直接依赖 `runtime-resolve`。
   - 控件目标归一化与 snapshot 文本/上下文精简。
   - 验证：既有 runtime/snapshot 测试和新增回归通过。

3. 实现交互命令与统一等待
   - `back`、`scroll`、`swipe`、`longpress`。
   - action 前后语义签名和 `--await change`。
   - 验证：CLI parser、mock runtime、超时和失败语义测试通过。

4. 扩展三个公开 Demo
   - 新增 interaction 页面与目录入口。
   - 构建 Taro/uni-app 产物。
   - 验证：Demo 静态测试、三项目构建通过，无敏感内容。

5. 同步契约与 Agent 指引
   - CLI help、README、Codex skill、product contracts。
   - 说明已知条件与未知变化等待的选择，不引导固定 sleep。
   - 验证：文档命令与实际 help 一致。

6. 完整验收与整理
   - `npm run build`、相关测试、`npm test`。
   - 公开 Demo 的 Mac DevTools real gate；记录真实限制。
   - 检查 diff、绝对路径/敏感信息、Trellis 上下文，按逻辑提交但不推送。
