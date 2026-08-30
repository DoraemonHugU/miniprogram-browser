# 跨平台验证研究

## 成熟实践

- GitHub Actions 官方支持 Linux、Windows 和 macOS 托管虚拟机，matrix 可按 OS 和语言版本生成独立 job。
  - https://docs.github.com/en/actions/get-started/understand-github-actions
  - https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/run-job-variations
- Tauri 等成熟跨平台桌面项目使用 GitHub Actions 分别在 Windows、Linux、macOS runner 上构建/测试，不将单机交叉编译视为同等证据。
  - https://v2.tauri.app/distribute/pipelines/github/
  - https://v2.tauri.app/distribute/windows-installer/
- 需要本机 GUI、持久登录态或专有工具时，GitHub 官方提供 Windows/macOS/Linux self-hosted runner，用户管理工具安装和状态。
  - https://docs.github.com/en/actions/reference/runners/self-hosted-runners

## 对本项目的结论

- Hosted Windows 是验证 Node CLI 路径、子进程、临时目录和文件锁差异的最小成熟方案。
- Hosted Ubuntu 不是 WSL；它只能执行可注入的 WSL 纯函数测试，不能证明 Windows CLI 桥接成功。
- 微信开发者工具需要 GUI、登录与 automation 插件；普通 hosted runner 不应承载真实 L0 gate。
- 当前仓库是公开仓库，GitHub 官方明确警告不要把可持久访问个人环境的 self-hosted runner 直接挂到公开仓库。稳定版前的 Windows/WSL 真实证据优先在 Windows 本机手动执行 gate；若未来确需 Actions 调度，应使用与个人环境隔离的一次性 JIT runner 或私有验证仓库，不把日常 Windows/Mac 直接暴露给公开 workflow。
- 仓库当前没有已注册的 self-hosted runner；在当前 Mac 上新增 runner 也只能增加 Mac 证据，不能验证 Windows/WSL。

## 依赖评估

- `actions/checkout`、`actions/setup-node`、`actions/setup-python` 由 GitHub 官方维护，均为活跃、非 archived 的 MIT 项目；本任务使用当前稳定 major `v7`。
- 不新增 npm 依赖、虚拟机工具或第三方 WSL action。

## Node 版本边界

- Node 官方当前将 24 列为 LTS，18 已 EOL：https://nodejs.org/en/about/previous-releases
- 经用户确认，beta.9 将 `engines.node` 从无现实依据且已 EOL 的 `>=18` 收口到 `>=22`，CI 验证 Node 22/24 两条 LTS。
- 这是已授权的公开兼容面变更，必须写入 beta.9 release notes。

## 依赖审计结论

- `npm audit` 最初报告 3 critical、3 high、7 moderate，根因主要是 `jimp@0.6.4` 及 `miniprogram-automator` 固定在旧 Jimp 兼容范围。
- 不能把旧 Jimp 的 `phin@2` 直接 override 到 `phin@3`：`@jimp/core@0.6.8` 使用 callback，而 `phin@3.7.1` 主 API 已变为 Promise，强制覆盖会破坏运行时。
- 采用 Jimp v0 最后的稳定版 `0.22.12`，并让 `miniprogram-automator` 共享同一版本；其 `Jimp.read(Buffer)` API 仍满足二维码解码和本项目截图处理。同步把已在声明范围内的 `ws`、`follow-redirects`、`brace-expansion` 更新到修复版本。
- 更新后 `npm audit` 为 0 critical、0 high、5 moderate。剩余项来自 Jimp v0 的 `file-type@16`；修复需要迁移到 Jimp v1，而 v1 改变 import、构造、resize 与导出 API，不在 beta.9 发布整理中冒险迁移。
- npm 只读取安装根项目的 `overrides`；`miniprogram-browser` 作为依赖安装时，它自身的 override 不会约束 `miniprogram-automator`，全新消费者项目会重新装入旧 Jimp。beta.9 因此只内置 `miniprogram-automator`，由 npm 连同确定的 Jimp 0.22.12 传递树打包；不使用 postinstall 修改、运行时兼容分支或未发布 fork。
- 新增跨平台 tarball 门禁，实际执行 pack、空项目 install、两条 Jimp 解析路径校验和 CLI `version/help`，避免只验证源码工作树。
- Jimp v1 迁移说明：https://jimp-dev.github.io/jimp/guides/migrate-to-v1/

## Demo 依赖审计边界

- 两套框架 Demo 均为 `private`，也不会进入 `miniprogram-browser` npm 包，但其构建依赖仍需单独维护。
- `npm audit --omit=dev` 当前报告：Taro 依赖树 3 critical / 6 moderate，uni-app 依赖树 11 high / 9 moderate / 11 low。主要来自 Taro/Swiper 与 uni-app/Vite/旧编译链的上游依赖。
- audit 给 Taro 的自动修复建议会把 4.2.1 降到 3.x，给 uni-app 的部分建议同样跨越框架版本契约；不使用 `npm audit fix --force` 破坏可复现 Demo。
- 这些告警不阻断 beta.9 CLI 包准备，但必须作为独立的 Demo 框架升级任务处理，并在升级后重跑三框架同构测试和真实 DevTools gate。
