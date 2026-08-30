# 准备 beta.9 发布与跨平台 CI

## Goal

将当前已验证的 CLI、Codex skill 和三框架公开 Demo 整理为 `0.1.0-beta.9` 发布候选，并用成熟的托管 CI 矩阵覆盖 macOS、Windows 和 Linux 上的可自动验证边界。

## Requirements

- 根 `package.json` 与 `package-lock.json` 同步更新为 `0.1.0-beta.9`，不修改 Demo 子项目版本。
- 增加 GitHub Actions 托管 matrix，在 macOS、Windows、Ubuntu 上用受支持的 Node.js 版本运行 build、strict typecheck 和 Node 测试。
- 每个 OS/Node 组合执行真实 tarball 安装门禁；在单独 Linux job 中运行 lint、图像处理测试和 Taro/uni-app 构建，不在每个 OS 重复高成本的框架构建。
- 明确区分托管 CI 与真实 DevTools gate：CI 不伪造微信登录态，WSL 与 Windows DevTools 联动仍需真实 Windows 环境。
- 在当前 Mac 上重跑默认发布门禁、两条真实 DevTools gate 和三框架公开 Demo 交互验证。
- 生成一份可复用于 annotated tag 和 GitHub prerelease 的简体中文发布说明，不包含本机路径、账号或生产项目信息。
- 本任务只准备版本，不执行 commit、tag、push、`npm publish` 或 GitHub Release。

## Acceptance Criteria

- [x] 根 manifest 版本均为 `0.1.0-beta.9`，Demo 版本不变。
- [x] CI YAML 可解析，仅使用 GitHub 官方维护的 checkout/setup-node/setup-python actions。
- [x] 项目最低版本收口为 Node 22，matrix 包含 macOS、Windows、Ubuntu 与 Node 22/24 两条 LTS 线。
- [x] Mac 上 `npm test`、strict typecheck、lint、pack 和三框架构建通过。
- [x] Mac 上 Node 22/24 均通过 tarball 全新安装门禁，且 `miniprogram-automator` 与 CLI 解析到同一个 Jimp 0.22.12。
- [x] Mac 真实 DevTools gate 只使用 `demo/` 公开合成项目并通过，或保留准确的 skipped/failed 原因。
- [x] 发布说明与 pack 清单不包含 Demo、本机路径、真实 AppID、token、日志或截图。
- [x] 未执行任何外部发布写入。

## Notes

- 托管 Windows runner 能真实暴露 Node、路径分隔符、spawn 和文件系统差异，但不等于已完成微信开发者工具真实交互验收。
- GitHub 托管 runner 提供的 Linux 不等于 WSL；WSL 的最终证据只能来自实际 Windows + WSL + DevTools。

## Verification Result

- Node.js 22.23.2 / macOS arm64：347 个 Node 测试、19 个图像处理测试、strict typecheck、lint、pack 全部通过。
- Node.js 22.23.2 / npm 10 与 Node.js 24.20.0 / npm 11 的 tarball 全新安装、依赖解析和 CLI 启动门禁通过。
- 全新消费者项目的 tarball 在线审计为 0 critical、0 high、5 moderate，不再重现旧 Jimp 的 high/critical 项。
- Taro `build:weapp`、uni-app `build:mp-weixin` 和 `type-check` 通过。
- 原生、Taro、uni-app 三套公开 Demo 均通过真实 `open→path→snapshot` 与 15 项 L0 旅程。
- 官方 NVM 0.40.7 已安装到用户目录并安装 Node.js 22.23.2；仓库使用 `.nvmrc` 固定开发基线为 22，不修改 shell 启动文件。
- Node 22 下 public demo 的 page、annotate/focus、layout/capsule 真实截图均成功生成并完成视觉检查；完整截图包含系统栏时，annotate 标签与 focus 框的内容窗口坐标映射正确。
- 根依赖审计由 3 critical / 3 high / 7 moderate 收口为 0 critical / 0 high / 5 moderate；剩余项需单独迁移 Jimp v1。
- Taro/uni-app 私有 Demo 的上游依赖仍有 audit 告警；它们不进入 npm pack，已记录为独立框架升级事项，不以 `audit fix --force` 降级框架。
