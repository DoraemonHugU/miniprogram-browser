# 设计：发布候选与跨平台验证

## 1. 验证分层

1. 托管 CI matrix：在真实 macOS、Windows、Ubuntu runner 上验证 Node CLI 的构建、类型和测试，捕获操作系统文件系统、路径和子进程差异。
2. Mac 发布门禁：完整执行本地质量检查与真实 DevTools 公开 Demo gate。
3. Windows/WSL 真实 gate：保留为稳定版前的真机证据，不用 Linux runner、环境变量注入或单元测试冒充；公开仓库不绑定含个人环境的持久 self-hosted runner。

## 2. CI 矩阵

- OS：`ubuntu-latest`、`windows-latest`、`macos-latest`。
- Node：22 和 24 两条当前 LTS 线，`engines.node` 同步收口为 `>=22`。
- 每个组合执行 `npm ci`、build、strict typecheck、Node 测试和 tarball 全新安装门禁。
- 单独 Ubuntu job 执行 lint、图像处理测试和 Demo 构建，避免把与 OS 无关的高成本步骤放大六倍。
- 仅使用 GitHub 官方 actions，不引入第三方 WSL 或 GUI 自动化 action。

## 3. 发布边界

- `npm version 0.1.0-beta.9 --no-git-tag-version` 只更新根 manifest。
- 发布说明保存在被 Git 忽略的 `artifacts/` 目录，后续 tag 和 GitHub Release 共用同一文件。
- 本轮不创建 release commit/tag，不 push，不调用 npm/GitHub 发布 API。
