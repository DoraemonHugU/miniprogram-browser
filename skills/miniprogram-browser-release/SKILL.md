---
name: miniprogram-browser-release
description: 为 miniprogram-browser 规划或执行版本更新、npm CLI 发布、Git tag / GitHub Release 与仓库 skills 同步时使用；不用于上传或发布微信小程序。
---

# miniprogram-browser Release

只在仓库根 `package.json` 的 `name` 为 `miniprogram-browser` 时使用本技能。其他项目使用通用 Release skill。

本流程参考成熟的 [release-skills](https://skills.sh/jimliu/baoyu-skills/release-skills)，但按本仓库的 beta 版本线、双分发边界和真实 DevTools 门禁进行了收敛。版本判断遵循 [Semantic Versioning 2.0.0](https://semver.org/)，npm tag 与打包边界以 [npm publish 官方文档](https://docs.npmjs.com/cli/commands/npm-publish) 为准。

## 发布模型

- `package.json` 是 CLI 版本来源，根 `package-lock.json` 必须保持同一版本；不要改 Demo 子项目版本。
- npm 分发 `dist/`、`README.md`、`LICENSE`、package metadata，以及 manifest 明确声明的 bundled dependencies；当前 beta 线内置 `miniprogram-automator` 的确定依赖树。`skills/`、`demo/` 和测试不进入 npm 包，通过 GitHub 仓库分发。
- Git tag 使用 `v<version>`；beta GitHub Release 必须标为 prerelease。
- 不要只根据最新 Git tag 推断当前版本。先对照根 manifest 与 npm registry；历史 tag / GitHub Release 可能不完整。
- 本技能不调用 `miniprogram-ci`，不上传、预览或发布任何微信小程序。
- 真实门禁只允许使用 `demo/` 下的公开合成项目。不得把生产项目的源码、AppID、路径、文案、截图、日志或运行数据写入仓库、release notes 或发布物。

## 权限边界

先识别用户要的是哪一层：

- **状态 / 计划**：只读检查并给出建议版本，不改文件。
- **准备版本**：在用户确认目标版本后更新根 manifest，生成或整理 release notes，并运行门禁；不自动 commit、tag、push 或 publish。
- **执行发布**：commit、tag、push、`npm publish`、GitHub Release 都是独立的外部或历史写入。执行前列出准确目标，并确认用户已授权对应动作。

不要因为用户只说“准备发布”就扩大为推送或发布。不要自动拆分现有未提交改动，也不要用 `git add .` 吸收无关文件。

## 1. 只读盘点

至少核对：

```bash
git status --short
git branch --show-current
git remote -v
node -p "require('./package.json').version"
node -p "require('./package-lock.json').version"
npm view miniprogram-browser versions dist-tags --json
git tag --sort=-version:refname
gh release list --limit 20
```

同时阅读实际 diff、`AGENTS.md`、`.trellis/spec/cli/product-contracts.md`、`skills/miniprogram-browser/SKILL.md` 和 `README.md`。提交信息只是辅助信号；公共 CLI 行为、错误输出、skill 指引和包内容以当前 diff 为准。

如果工作树不干净，仍可做状态分析和版本建议；在 commit/tag/publish 前必须明确哪些改动属于本次发布，并确认没有未预期文件。

## 2. 决定版本

先展示建议与理由，再等待用户确认目标版本。

- 对 `x.y.z-beta.n` 的日常 beta 迭代，默认建议同一基线的下一个未发布编号，例如 `beta.8 → beta.9`。
- 同时比较本地 manifest 与 registry。同一目标版本已经发布时立即停止；npm 版本不可重复使用。
- 如果本地版本高于 registry，先判断它是尚未发布的目标版本，还是遗留修改，不要机械再加一。
- beta 期间的破坏性变化也必须明确写入 release notes；是否切换基线（如 `0.1.0-beta.n → 0.2.0-beta.1`）由用户决定。
- 从 beta 提升为稳定版、移动 npm `latest`、或进入新的 major/minor 线都必须由用户明确决定，不能自动推断。

确认版本后，用 npm 同步根 manifest 与 lockfile：

```bash
npm version <version> --no-git-tag-version
```

随后重新核对两个版本字段完全一致，并确认 Demo 的 `package.json` 没有被改动。

## 3. Release notes

从上一个实际发布版本到当前候选版本的净 diff 生成面向用户的简体中文摘要，优先写：

- L0 公共命令和参数的新增、修复或破坏性变化；
- macOS / Windows / WSL 的连接、路径、等待、截图和 session 行为；
- `skills/miniprogram-browser`、`skills/image-processing` 或 Release skill 的使用变化；
- 新增或扩展的公开 Demo 与验证结论。

不要从文件名或 commit 前缀臆测功能，不写没有验证的性能数字，不把内部重构和测试数量堆成用户噪音。仓库没有维护 `CHANGELOG.md` 时，不要为了流程完整而擅自创建；为 annotated tag 和 GitHub Release 使用同一份临时 notes 文件即可。

## 4. 发布门禁

默认运行：

```bash
npm test
npm run typecheck:strict
npm run lint
npm run pack:check
```

再完成这些检查：

- 用当前 Agent 可用的 skill validator 校验所有新增或修改的 `skills/*/SKILL.md`。
- 检查 `npm pack --dry-run` 清单；除 manifest 明确声明的 bundled dependencies 外，不得意外包含 `node_modules/`，也不得包含 `skills/`、`demo/`、测试、本机路径、真实截图、DevTools 日志、token、AppID 或生产数据。
- 对涉及 open/connect、runtime、goto/click/fill、await、screenshot 或 session 的变化，在 macOS DevTools 可用时运行 `npm run test:real-open-gate` 和 `npm run test:l0-e2e`，目标必须是 `demo/` 下的公开合成项目。
- 缺少真实 DevTools 环境时明确记录为 skipped；不要把 mock 测试写成真实门禁已通过。

任一门禁失败就停止发布，保留原始错误，不通过改弱测试或忽略包清单来放行。

## 5. 执行已授权的发布动作

只执行用户已经确认的部分：

1. 精确 stage 本次发布文件并创建 release commit，推荐消息 `chore: release v<version>`。
2. 用最终 release notes 创建 annotated tag：`git tag -a v<version> -F <notes-file>`。
3. 用户授权后再 push commit 和该 tag；不要使用 `git push --tags`。
4. beta 发布使用 `npm publish --tag beta`；稳定版只有在用户明确确认后才使用默认 stable tag。
5. 发布后用 `npm view miniprogram-browser version dist-tags --json` 验证 registry 状态。
6. 用户授权后创建同 tag 的 GitHub Release；beta 使用 `gh release create ... --prerelease --notes-file <notes-file>`。

npm CLI 与 GitHub skills 是两个发布结果。只完成 `npm publish` 不代表 skill 已更新；只有相关 commit 推送到 GitHub 后，skills.sh 安装端才能获取新指引。

## 交付

最后明确报告：目标版本、改动过的版本文件、四项默认门禁、真实 DevTools 门禁、skill 校验、npm 包清单、创建的 commit/tag、push/npm/GitHub Release 各自是否执行，以及所有 skipped/failed 项。不要把“已准备”写成“已发布”。
