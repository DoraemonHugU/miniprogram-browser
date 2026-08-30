# 修复 Windows 游客模式 automation 冷启动

## Goal

让 Windows/WSL 下的 `open` 在游客态失败时准确报告官方 DevTools CLI 的真实边界，不把所有 `code 10` 误报为登录 token 失效，也不把仅 Tool endpoint 可用误报为 App runtime 成功。

## Requirements

- 保留 Windows 盘符路径现有 `open → auto` 冷启动策略；没有真实 App runtime 证据时不得改成直接 `auto` 假成功。
- 区分 DevTools `code 10` 的不同原文：`INVALID_LOGIN` / `access_token` / `需要重新登录` 属于登录失败；`不存在此 AppID` 属于 AppID 打开失败。
- JSON 继续保留完整 `raw`，文本输出保留可读摘要；高层说明不得覆盖底层错误。
- automation Tool endpoint 可连但 App runtime 不响应时，不得提前订阅 App 级事件；连接关闭必须返回受控、结构化状态，不得因 `App.enableLog` 的未等待 Promise 泄漏堆栈并崩溃。
- Windows `cmd.exe / cli.bat` 必须完整保留含空格和中文的项目路径 argv；macOS direct executable 路径不受该二次解析边界影响。
- README、Skill 与 CLI 契约明确：公开 `touristappid` 用于数据隔离，不代表官方 automation 无需 DevTools 登录；游客 GUI 可用与 App automation ready 是两层事实。
- 不新增依赖，不访问生产小程序，不修改 DevTools 全局设置。

## Acceptance Criteria

- [x] 精确的 `INVALID_LOGIN` / `需要重新登录` 原文仍解释为登录失败并保留 raw。
- [x] `code 10 / 不存在此 AppID` 解释为 AppID 打开失败，消息中不再声称 access token 过期。
- [x] Tool-only endpoint 不注册会隐式触发 `App.enableLog` 的 console 监听，并有定向测试。
- [x] Windows 本机 `cmd.exe + cli.bat` 回归确认空格/中文 `--project` argv 完整到达 open/auto/cleanup。
- [x] `npm run build` 与相关 runtime/CLI 测试通过。
- [x] Windows 公开 `touristappid` gate 复测保留准确原始失败；未达到 App runtime ready 时不运行 L0。
- [x] 提交内容不包含生产 AppID、真实项目路径、截图、运行日志或临时副本。

## Notes

- 基线：`ee79f275b9bd706df36c1a7b809b694a7436406a`。
- Windows DevTools：`2.02.2608060`；Node：`v22.22.0`。
- 本机实测 direct `auto` 会打印 `Using AppID: touristappid / ✔ auto`，但 `Tool.getInfo` 成功后 `App.getCurrentPage` 仍超时；warm/cold 和 `--pure-simulator` 均一致。
- 修复后真实 `test:real-open-gate` 仍在 `open` 失败（exit 1），但准确保留 `code: 10 / 不存在此 AppID`；session cleanup exit 0，未运行 L0。
- PR 首轮 CI 的 Windows Node 22/24 暴露 `.bat` argv 二次解析失败；独立 F 盘 checkout 已用 Windows Node + 假 DevTools CLI 复现并验证引用修复。
