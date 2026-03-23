# miniprogram-browser

面向微信小程序的 `agent-browser` 风格自动化 CLI。配套 skills 分别放在 `skills/miniprogram-browser/` 和 `skills/image-processing/`。

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
npx skills add https://github.com/DoraemonHugU/miniprogram-browser/tree/main/skills/miniprogram-browser
```

这个 skill 目录现在只包含 `SKILL.md`，不会再把 `tests/` 或 CLI 源码一起装进去。

如果要安装离线图片处理 skill，可使用：

```bash
npx skills add https://github.com/DoraemonHugU/miniprogram-browser/tree/main/skills/image-processing
```

如果只想给特定 agent 安装，可继续使用 `skills` CLI 的 `--agent` / `--global` 等参数。

### 本地开发

```bash
npm install
npm test
node scripts/miniprogram-browser.cjs help
```

本地跑完整测试前，还需要系统里有可用的 `python` 命令（用于图片处理 skill 的隔离虚拟环境和测试）。

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

# 已安装时
miniprogram-browser open --session demo --project /path/to/miniprogram-root
miniprogram-browser app inspect --session demo
miniprogram-browser goto /pages/dashboard/index --session demo
miniprogram-browser snapshot -i --session demo
miniprogram-browser click @e1 --session demo
miniprogram-browser timeline --session demo
miniprogram-browser screenshot --session demo --mode annotate
miniprogram-browser screenshot --session demo --mode annotate --focus @e16,@e17

# 未安装时
npx miniprogram-browser help
```

## 这是什么

`miniprogram-browser` 把微信小程序自动化收敛成更适合 agent 使用的工作流：

- `open / goto / snapshot / click / fill / get`
- `app inspect / timeline / logs / exceptions`
- `eval / native / call wx / call page`
- `screenshot --mode page|visual|annotate`
- `screenshot --focus @e1,@e2`
- `screenshot --no-ref`
- `snapshot -i --layout`
- `screenshot --mode layout`

它不是浏览器 DOM 自动化，而是基于 `miniprogram-automator` 的运行时元素能力重建语义树。

仓库里还附带一个独立的离线图片处理 skill：`skills/image-processing/`。

它用于把已有图片整理成更适合人和模型分析的输入，当前包含：

- `img_montage.py`：多图拼接
- `img_diff.py`：差异分析与差异框输出
- `img_focus.py`：按显式 box 裁剪并放大局部
- `img_overlay.py`：叠加对比辅助图

这个 skill 不负责自动截图或自动回归；它更适合和 `miniprogram-browser` 产出的截图配合使用。

## 当前能力

- 运行时语义快照与 `@eNN` refs
- 多 session 并发；同一 session 串行；通常复用当前 live DevTools HTTP 端口，只隔离 autoPort
- 应用结构摘要（`app inspect`）
- 路由时间线、console、exception
- 页面截图、视觉截图、标注截图
- 低层逃逸点：`eval / native / get attr|prop|get rect`

## 已知边界

- fresh `open` 后，DevTools 模拟器首帧有时还没稳定；建议先 `path` / `app inspect`，必要时再 `goto` 当前页一次
- 如果真实 `screenshot` 偶发超时，优先切到 `screenshot --mode layout`，其次再看 `snapshot -i --layout`；不要把 `close/open` 或重启 DevTools 当默认修复手段
- 某些自定义组件在 automator 运行时里不透明，语义增强不能 100% 覆盖
- 当前更适合定位为 **beta**，不建议直接宣称为稳定版 `1.0`

## 已知问题（当前重点）

### 1. WSL 项目路径下，截图可能偶发超时

目前在 `//wsl.localhost/...` 这类 WSL 路径下，微信开发者工具偶尔会进入异常文档状态；表现为：

- `snapshot/path/timeline` 仍然可用
- 但 `screenshot --mode page` 可能卡住，最后报 `screenshot timeout`

这更像是 DevTools / `miniprogram-automator` 底层截图通道没有返回，而不是本工具在上层做了错误转换。

当前建议：

- 优先避免在 WSL 路径上做高频截图
- 鼓励在每次 `goto / click / fill / call / native` 之后适度 `wait`，避免操作链过快
- 截图前先 `path` / `snapshot -i` 确认页面已经稳定，再执行 `screenshot`
- 尽量不要把很多跳转、点击、截图压成一条过快的链式命令
- 如果已经出现过 `screenshot timeout`，不要在同一个节奏里连续硬试很多次；先停一下，再人工决定是否 `close/open`

### 2. `wait 800` 只是固定 sleep，但仍然值得显式使用

例如：

```bash
miniprogram-browser goto /pages/preferences/index --session demo
miniprogram-browser wait 800 --session demo
miniprogram-browser screenshot --session demo
```

这里的 `wait 800` 只是额外等 800ms，不会检查页面是否真的完成异步渲染；但在当前 DevTools / automator 截图链路下，显式 `wait` 仍然有现实价值，因为它能减少“操作刚发生就立刻截图”的失败率。

更稳妥的方式是：

- 每次页面操作后都适度 `wait`，不要让命令链跑得太快
- 先 `path` / `app inspect` 确认状态
- 或先 `snapshot -i` 确认关键节点已经出现、结构已经稳定
- 再执行截图

## 布局分析

如果希望模型通过文字理解页面布局，可以在语义快照里附加比例布局信息：

```bash
miniprogram-browser snapshot -i --layout --session demo
```

开启后，每个 ref 会附带相对窗口的比例位置/尺寸：

```text
@e20 [button] 工具箱 {x:10.4,y:82.1,w:24.5,h:6.8}
```

含义：

- `x` / `y`: 左上角相对窗口的百分比位置
- `w` / `h`: 相对窗口的百分比宽高

这比绝对像素更适合给模型做跨设备布局分析。

如果希望在截图失败时生成一张可读的结构替代图，也可以直接用：

```bash
miniprogram-browser screenshot out.png --session demo --mode layout --focus @e20,@e21
miniprogram-browser screenshot out.png --session demo --mode layout --no-ref
```

如果想让布局图更接近当前语义快照，也可以切到紧凑模式：

```bash
miniprogram-browser screenshot out.png --session demo --mode layout -c
```

`layout` 模式特点：

- 默认使用语义布局层，更适合快速阅读
- `-c/--compact` 时改用更紧凑的语义布局
- `--raw` 时切到更底层的运行时节点布局
- 容器使用确定性多色分组，增强区分度
- 中文文本通过纯 JS 字体路径渲染叠加，不依赖浏览器截图
- 可继续叠加 `--focus` 高亮
- `--no-ref` 时隐藏图片里的 `@eN` 标签，但不影响 focus 框
- 可选 `--capsule` 叠加右上角微信胶囊

## Skill 集成

这个仓库现在采用更标准的双分发布局：

- npm / npx 负责 CLI 运行时
- `skills/miniprogram-browser/` 负责 agent skill 安装
- `skills/image-processing/` 负责离线图片处理 skill 安装

如果你要作为 OpenCode / `.opencode` skill 使用，安装这个目录即可：

```text
skills/miniprogram-browser/
```

这个 skill 目录现在是 instruction-only：

```text
skills/miniprogram-browser/
  SKILL.md
```

真正执行命令时，可按环境选择：

```bash
miniprogram-browser ...
# 或
npx miniprogram-browser ...
```

`tests/` 和 `scripts/` 都保留在仓库根目录，只用于源码、npm 包和开发验证，不会随 skill 子目录一起安装。

也可以直接通过 `skills` CLI 从 GitHub 安装：

```bash
npx skills add https://github.com/DoraemonHugU/miniprogram-browser/tree/main/skills/miniprogram-browser
npx skills add https://github.com/DoraemonHugU/miniprogram-browser/tree/main/skills/image-processing
```

本地调试 skill 时，也可以直接装仓库内子目录：

```bash
npx skills add ./skills/miniprogram-browser
```

## 测试

```bash
npm test
```

现在 `npm test` 会同时执行：

- 现有 Node 测试
- `skills/image-processing/` 的 Python 图片处理测试

其中图片处理测试会在 `artifacts/.venv-image-processing-tests/` 下创建隔离虚拟环境并安装 `skills/image-processing/requirements.txt`。

因此本地开发或 CI 运行完整测试时，需要：

- 系统里能直接调用 `python`
- Python 自带 `venv`
- 能通过 `pip` 安装 `skills/image-processing/requirements.txt` 里的依赖

`tests/` 会随仓库一起提交。对这类自动化工具，测试不是噪音，而是可信度的重要部分。

## 仓库结构

```text
scripts/                     CLI 与运行时实现
skills/miniprogram-browser/  可安装的标准 skill 目录（仅 SKILL.md）
skills/image-processing/     可安装的离线图片处理 skill
tests/                       行为测试
README.md                    面向人类开发者的开源说明
```

## License

MIT
