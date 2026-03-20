# miniprogram-browser

面向微信小程序的 `agent-browser` 风格自动化 CLI 与 skill。

当前状态：**beta / preview**。

- GitHub: https://github.com/DoraemonHugU/miniprogram-browser
- npm: https://www.npmjs.com/package/miniprogram-browser

## 安装

### 直接试用（未安装）

```bash
npx miniprogram-browser help
```

### 全局安装后使用

```bash
npm install -g miniprogram-browser
miniprogram-browser help
```

### 作为 Skill 安装（skills.sh / OpenCode 等）

```bash
npx skills add https://github.com/DoraemonHugU/miniprogram-browser
```

如果只想给特定 agent 安装，可继续使用 `skills` CLI 的 `--agent` / `--global` 等参数。

### 本地开发

```bash
npm install
npm test
node scripts/miniprogram-browser.cjs help
```

## 前置条件

使用前请确保：

1. 已安装并登录微信开发者工具
2. 已在开发者工具中开启 **服务端口**
3. `--project` 指向的是 **开发者工具实际打开的小程序项目根目录**
4. CLI 路径配置正确：
   - 标准安装路径下，工具会优先尝试自动探测
   - 非标准安装路径 / WSL 场景下，建议设置环境变量 `WECHAT_DEVTOOLS_CLI`

例如：

```bash
export WECHAT_DEVTOOLS_CLI=/path/to/cli
```

如果你的 shell 已经设置了 `WECHAT_DEVTOOLS_CLI`，就不需要重复 `export`。

## 最短可运行示例

```bash
# 如果本地还没设置 WECHAT_DEVTOOLS_CLI，再先 export
export WECHAT_DEVTOOLS_CLI=/path/to/cli

# 已全局安装时
miniprogram-browser open --session demo --project /path/to/miniprogram-root
miniprogram-browser app inspect --session demo
miniprogram-browser goto /pages/dashboard/index --session demo
miniprogram-browser snapshot -i --session demo
miniprogram-browser click @e1 --session demo
miniprogram-browser timeline --session demo
miniprogram-browser screenshot --session demo --mode annotate

# 未安装时，也可以直接用 npx
npx miniprogram-browser help
```

## 这是什么

`miniprogram-browser` 把微信小程序自动化收敛成更适合 agent 使用的工作流：

- `open / goto / snapshot / click / fill / get`
- `app inspect / timeline / logs / exceptions`
- `eval / native / call wx / call page`
- `screenshot --mode page|visual|annotate`

它不是浏览器 DOM 自动化，而是基于 `miniprogram-automator` 的运行时元素能力重建语义树。

## 当前能力

- 运行时语义快照与 `@eNN` refs
- 多 session / 端口隔离
- 应用结构摘要（`app inspect`）
- 路由时间线、console、exception
- 页面截图、视觉截图、标注截图
- 低层逃逸点：`eval / native / get attr|prop|get rect`

## 已知边界

- fresh `open` 后，DevTools 模拟器首帧有时还没稳定；建议先 `path` / `app inspect`，必要时再 `goto` 当前页一次
- 某些自定义组件在 automator 运行时里不透明，语义增强不能 100% 覆盖
- 当前更适合定位为 **beta**，不建议直接宣称为稳定版 `1.0`

## Skill 集成

如果你要作为 OpenCode / `.opencode` skill 使用，保留以下文件即可：

```text
SKILL.md
scripts/
```

测试与参考资料可以保留在仓库中，但不一定需要分发到最终 skill 目录。

也可以直接通过 `skills` CLI 从 GitHub 安装：

```bash
npx skills add https://github.com/DoraemonHugU/miniprogram-browser
```

## 测试

```bash
npm test
```

`tests/` 会随仓库一起提交。对这类自动化工具，测试不是噪音，而是可信度的重要部分。

## 仓库结构

```text
scripts/    CLI 与运行时实现
tests/      行为测试
SKILL.md    面向 agent / skill loader 的说明
README.md   面向人类开发者的开源说明
```

## License

MIT
