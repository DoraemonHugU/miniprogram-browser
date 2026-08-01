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

发布边界要分清：

- npm 包只分发 CLI 运行时
- GitHub 仓库负责同步 `skills/miniprogram-browser/` 和 `skills/image-processing/`
- 因此发布新版本时，`npm publish` 之外还需要把仓库推到 GitHub，skill 安装端才会看到最新 `SKILL.md`

如果要安装离线图片处理 skill，可使用：

```bash
npx skills add https://github.com/DoraemonHugU/miniprogram-browser/tree/main/skills/image-processing
```

如果只想给特定 agent 安装，可继续使用 `skills` CLI 的 `--agent` / `--global` 等参数。

### 本地开发

```bash
npm install
npm run build
npm test

# 可选：真机 open 门禁（需本机 DevTools；缺环境 exit 2）
# export WECHAT_DEVTOOLS_CLI=...
# export MINIPROGRAM_BROWSER_GATE_PROJECT=...
npm run test:real-open-gate
npm run test:l0-e2e           # L0 旅程+分支（goto/session/click…）
node dist/miniprogram-browser.js help
```

CLI 源码位于 `src/**/*.ts`，发布和本地执行入口由 TypeScript 编译到 `dist/**/*.js`。本地跑完整测试前，还需要系统里有可用的 `python` 命令（用于图片处理 skill 的隔离虚拟环境和测试）。

## 前置条件

使用前请确保：

1. 已安装并登录微信开发者工具
2. 已在开发者工具中开启 **服务端口**
3. 首次使用需要能确定小程序项目根目录；可以显式传 `--project`，也可以从当前目录 / Git 工作树唯一发现
4. CLI 路径配置正确：
   - 标准安装路径下，工具会优先尝试自动探测
   - 非标准安装路径 / WSL 场景下，建议设置环境变量 `WECHAT_DEVTOOLS_CLI`
5. WSL 场景下，`--project` 仍然填写 Linux 侧可读的小程序根目录；CLI 会按平台自动把可识别路径传给 DevTools

例如：

```bash
export WECHAT_DEVTOOLS_CLI=/path/to/cli
```

如果你的 shell 已经设置了 `WECHAT_DEVTOOLS_CLI`，就不需要重复 `export`。

### 跨平台项目路径

`miniprogram-browser` 会按当前平台自动处理传给微信开发者工具 CLI 的项目路径。正常情况下只传当前 shell 可读的 `--project`；如果当前目录或同 Git 工作树能唯一发现小程序项目，也可以省略：

- macOS / Windows：直接使用项目根目录（`projectStrategy=direct`）
- WSL + Windows 盘挂载：`/mnt/d/...` 会自动转成 `D:\...`（`projectStrategy=wsl-mounted-drive`）
- 显式指定 DevTools 侧路径：`--devtools-project`（`projectStrategy=explicit`）
- 显式前缀映射：`--project-map` / `WECHAT_DEVTOOLS_PROJECT_MAP`（`projectStrategy=project-map`）

```bash
miniprogram-browser open \
  --session demo \
  --project /mnt/d/work/demo/apps/miniprogram

miniprogram-browser open --session demo
```

**推荐**：WSL 下把小程序项目放在 `/mnt/<drive>/...`（Windows 盘），路径转换最稳。  
`/home/...` 等 Linux 侧路径不再走受控镜像复制；若 DevTools 无法直接消费该路径，请改用 Windows 盘项目，或：

```bash
# 高级兜底：显式指定 DevTools 侧 Windows 路径
miniprogram-browser open \
  --session demo \
  --project /home/wang/work/demo/apps/miniprogram \
  --devtools-project 'P:\work\demo\apps\miniprogram'

# 高级兜底：前缀映射（只做字符串替换，不复制项目）
miniprogram-browser open \
  --session demo \
  --project /home/wang/work/demo/apps/miniprogram \
  --project-map '/home/wang/work=P:\work'
```

也可以用环境变量固定多个映射，分号分隔，最长前缀优先：

```bash
export WECHAT_DEVTOOLS_PROJECT_MAP='/home/wang/work=P:\work;/home/wang/tmp=T:\tmp'
```

`open/doctor` 成功时会回显 `project` / `devtoolsProject` / `strategy` / `autoPort` 等必要信息，便于确认实际连上的实例。
## 最短可运行示例

```bash
# 如果本地还没设置 WECHAT_DEVTOOLS_CLI，再先 export
export WECHAT_DEVTOOLS_CLI=/path/to/cli

# 已安装时
# 在小程序项目目录或同 Git 工作树里，通常可以省略 --project 与 --session
# 省略 --session 时自动生成/复用 {project}-xN（如 earlyriser-x1）；同项目有多个不同 live runtime 时需显式指定
miniprogram-browser open
miniprogram-browser open --project /path/to/miniprogram-root
miniprogram-browser snapshot -i
miniprogram-browser click @e1
miniprogram-browser open --session work   # 需要并行工作台时再显式命名
miniprogram-browser doctor --json
miniprogram-browser goto /pages/dashboard/index
miniprogram-browser timeline
miniprogram-browser devtools logs --limit 40 --grep "appservice|simulator|error"
miniprogram-browser screenshot --mode annotate

# 未安装时
npx miniprogram-browser help
```

## 推荐启动策略

日常优先这样理解 `open`：

- `open` 已经默认等待通用 `stable` 条件
- 常规链路不要在 `open` 后立刻再补一条 `await stable`
- 如果 fresh 启动时人类已经**看到页面显示出来**，但 `open` 仍失败，不要立刻继续 `--fresh` 循环

更稳的处理顺序：

```bash
miniprogram-browser open --session demo --project /path/to/miniprogram-root --fresh

# 如果页面已经显示，但 open 仍失败
sleep 8
miniprogram-browser open --session demo --project /path/to/miniprogram-root
miniprogram-browser await app-ready --session demo
miniprogram-browser await stable --session demo
```

原因很简单：当前微信开发者工具有一类场景是**页面已经起来了，但 automation cli server 还没完全 ready**。这时继续反复 `--fresh` 往往比短等一次再复用现有 runtime 更不稳定。

## 这是什么

`miniprogram-browser` 把微信小程序自动化收敛成更适合 agent 使用的工作流：

- `open / goto / snapshot / click / fill / get`
- `app inspect / timeline / logs / exceptions`
- `doctor / devtools logs / protocol`
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
- 多 session 并发；同一 session 串行；默认 attach 同项目唯一 live runtime；多个不同 live runtime 时要求 `--session`，不会按最新记录猜测；`--fresh` 是显式新 runtime 逃逸点
- **session 与 runtime 解耦**：session 存 route/refs 等用户上下文，不固化 `autoPort`；连接端口由 runtime 池管理，后续命令自动回绑
- 默认项目级 session 管理；`session list --all` 是显式全局查看入口
- 共享同一 `autoPort` 的命令通过 runtime lock 串行执行；attached session 默认 `close` 只解绑，不关闭 owner runtime
- `open` 默认等待通用 `stable` 条件；底层启动/连接失败会自动收尾，已连接但稳定超时会保留 session 便于继续等待
- `session prune` 可清理当前项目 stale sessions 与 orphan runtime launch 记录
- 应用结构摘要（`app inspect`）
- 路由时间线、console、exception
- 分层诊断（`doctor`）：区分 DevTools CLI、automation WebSocket 和 App runtime
- DevTools 底层日志（`devtools logs`）：普通运行时日志拿不到时查看 `WeappLog`
- 页面截图、视觉截图、标注截图
- 低层逃逸点：`protocol / eval / native / get attr|prop|get rect`

## 已知边界

- 必须已登录微信开发者工具；登录 token 过期时无法启用自动化（无游客模式绕过）。失败时会给出人话说明，并保留 DevTools 原始错误
- fresh `open` 后，如果返回 `RUNTIME_UNSTABLE`，通常表示 runtime 已经部分可连接但页面仍在编译/刷新；优先继续 `await stable --session <name>`，再用 `doctor` / `devtools logs` 判断是否真的失败
- 如果 fresh 启动阶段已经看到页面显示，但 `open` 仍未成功，优先短等 5 到 10 秒，再重跑同一个 `open`；不要立刻再次 `--fresh`
- `--fresh` 仍受微信开发者工具当前自动化服务状态影响；日常让新 agent attach 到唯一 live runtime 更稳；若同时存在多个 live runtime，先用 `session list` 再显式传 `--session <name>`
- 仅知道 `devtoolsPort` 只代表 DevTools HTTP 服务活着，不代表当前小程序 runtime 已可 attach；手工已打开的实例建议先 `doctor --project <path> --devtools-port <port>`
- 如果 fresh 启动已经显示 `Using AppID: ...`，但后续仍连不上 automation，这通常不是路径或 AppID 问题，而是 DevTools 自身的 `cli server` / 编译链路仍未起来
- 如果真实 `screenshot` 偶发超时，优先切到 `screenshot --mode layout`，其次再看 `snapshot -i --layout`；不要把 `close/open` 或重启 DevTools 当默认修复手段
- 某些自定义组件在 automator 运行时里不透明，语义增强不能 100% 覆盖
- 当前更适合定位为 **beta**，不建议直接宣称为稳定版 `1.0`

## 已知问题（当前重点）

### 1. WSL 项目路径：优先 Windows 盘

在 `//wsl.localhost/...` / `\\wsl.localhost\...` 这类 WSL UNC 路径下，微信开发者工具 CLI 可能拒绝项目路径，并给出和二维码输出相关的误导性错误。

推荐做法：

- 把项目放在 `/mnt/<drive>/...`，让 CLI 自动转成盘符路径
- 或使用 `--devtools-project` / `--project-map` 显式给出 Windows 路径

如果已经绕过 open 阶段，真实截图通道仍可能在 WSL 路径下偶发超时，表现为：

- `snapshot/path/timeline` 仍然可用
- 但 `screenshot --mode page` 可能卡住，最后报 `screenshot timeout`

这更像是 DevTools / `miniprogram-automator` 底层截图通道没有返回，不应继续回退到 Windows GUI 截图或 OCR。

当前建议：

- WSL 优先使用 `/mnt/<drive>/...` 项目路径；必要时再用 `--devtools-project` / `--project-map`
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
- 未指定输出路径时写入系统临时目录（Linux 默认 `/tmp/miniprogram-browser`），使用短的项目/session/路由组合名；冲突自动追加 `-1`、`-2`……

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

`src/` 和 `tests/` 都保留在仓库根目录，`src/` 是 CLI 的 TypeScript 源码（编译到 `dist/`），`tests/` 为行为测试，二者不会随 skill 子目录一起安装。

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
src/                         CLI 与运行时实现（TypeScript，编译产物在 dist/）
skills/miniprogram-browser/  可安装的标准 skill 目录（仅 SKILL.md）
skills/image-processing/     可安装的离线图片处理 skill
tests/                       行为测试
README.md                    面向人类开发者的开源说明
```

## License

MIT
