---
name: miniprogram-browser
description: 当想要在微信开发者工具里用接近 agent-browser或者playwright 的方式操作小程序时加载。
---

# 微信小程序自动化：miniprogram-browser

## 概述

`miniprogram-browser` 用来把微信小程序自动化收敛成接近 `agent-browser` 的命令体验。

命令可按环境选择：

```bash
miniprogram-browser ...
# 或
npx miniprogram-browser ...
```

它适合让 agent 直接操作微信小程序，但要记住：

- `--project` 指向 agent 当前系统可读的小程序项目根目录；当前目录或同 Git 工作树能唯一发现项目时可以省略
- DevTools 实际接收的项目路径由 CLI 按平台自动推导（macOS/Windows 直传；WSL `/mnt/*` 转盘符；必要时用 `--devtools-project` / `--project-map`）
- 必须已登录微信开发者工具；登录过期时无法自动化，错误会保留 DevTools 原文
- 它不是浏览器 DOM 自动化，部分自定义组件在运行时里可能不透明

不要用它做上传、预览、发布、CI 打包；那属于 `miniprogram-ci`。

## 何时使用

- 想用 `snapshot -i`、`@e1`、`click`、`fill`、`get text` 这类 agent-friendly 命令
- 想优先走稳定 ref，而不是手写脆弱的 class 链或 nth 选择器
- 想查看当前页面状态、路由变化、日志、异常、应用结构摘要

## 模型分派：非识图 vs 识图

- **非识图模型（纯文本/结构化推理）**：默认用 `snapshot -i`。它输出结构化 ref 文本树 + 紧凑 ASCII 空间图，零真实像素、稳定，不依赖官方截图通道。
- **识图模型（能直接看图片）**：确实需要真实像素证据时，用 `screenshot --mode page|visual|annotate`（真实图片）。`screenshot` 默认 `mode` 为 `layout`（纯 JS/字体渲染的结构图，同样不走不稳定的官方截图）；要真实像素请显式 `--mode page|visual|annotate`。
- 不要把 `snapshot` 当真实截图工具：它默认只给结构化 + ASCII 空间图；要真实像素走 `screenshot --mode page|visual|annotate`，或 `snapshot -i --visual`。

## 核心心智

1. `open` 绑定的是一个**小程序实例 / session**，不是页面 URL
2. **session ≠ runtime**：session 存 route/refs；`autoPort` 等连接信息在 runtime 池，后续命令会自动回绑
3. `open` 默认复用同项目唯一 live runtime；没有才启动；`--fresh` 才强制新 runtime
4. `open` 默认会等待通用稳定条件；超时不一定代表小程序已失败，可能只是还在编译/刷新，可继续用 `await stable` 或 `doctor` 判断
5. 常规使用不要自己再额外手拼 DevTools `cli open`；`open/connect` 已包揽 trust / 路径 / 端口等脏活
6. 绑定后先 `path` 或 `app inspect` 确认当前状态
7. 再 `goto` 到目标路由；页面跳转或点击后优先用 `--await`，不要先猜固定毫秒
8. 先用 `logs` / `exceptions` 看运行时输出，理解小程序当前发生了什么
9. 非识图模型优先用 `snapshot -i`：默认输出结构化 ref 文本树 + 紧凑 ASCII 空间图（零真实像素、稳定）
10. 需要纯文字比例 rect 时，用 `snapshot -i --layout`（文本树额外附 x/y/w/h 百分比）
11. 需要稳定 ref 时，再 `snapshot -i` 生成 `@eN` refs
12. 识图模型、且确实需要真实像素证据时，用 `screenshot --mode page|visual|annotate`
13. 页面明显变化后，重新 `snapshot -i`

如果你的目标是让模型稳定理解页面结构，优先使用：

```bash
miniprogram-browser snapshot -i --session feat-a
miniprogram-browser snapshot -i --session feat-a --no-map
miniprogram-browser screenshot out.png --session feat-a --mode layout --focus @e20,@e21
miniprogram-browser screenshot out.png --session feat-a --mode layout --no-ref
miniprogram-browser screenshot out.png --session feat-a --mode layout -c --capsule
```

`snapshot -i` 默认输出两部分，用同一 `@eN` ref 交叉引用：

- 结构化 ref 文本树：层级 + ref + 文本标签
- 紧凑 ASCII 空间线框：用 `rectPct`（窗口百分比，与 DPI 无关）渲染；**先读语义树再读图**。图中数字 = `@eN` 的编号；够大的区域/控件画边框，过小元素只标数字；数字会智能避让，`*` 表示避让失败。可用 `--no-map` 关闭

需要纯文字比例 rect 时，改用：

```bash
miniprogram-browser snapshot -i --layout --session feat-a
```

它会为每个 ref 附加相对窗口的比例位置/尺寸（`x/y/w/h` 百分比）。

`layout` 截图模式会：

- 默认使用语义布局层渲染结构图
- `-c/--compact` 时输出更紧凑的语义布局
- `--raw` 时切到更底层的运行时节点布局
- 用确定性多色分组增强层次区分
- 通过纯 JS 字体路径叠加中文文本
- 继续支持 `--focus` 高亮
- `--no-ref` 时隐藏图片里的 `@eN` 标签，但不影响 focus 框
- 可选 `--capsule` 叠加右上角微信胶囊

## 最常用流程

```bash
# 如果本地还没设置 WECHAT_DEVTOOLS_CLI，再先 export
export WECHAT_DEVTOOLS_CLI=/path/to/cli

# 最短路径：可省略 --session（自动 earlyriser-x1 这类名字）
miniprogram-browser open --project /path/to/miniprogram-root
miniprogram-browser snapshot -i
miniprogram-browser click @e1 --await route-change

# 需要并行时再显式命名
miniprogram-browser open --session work --project /path/to/miniprogram-root
miniprogram-browser open --session debug --project /path/to/miniprogram-root --fresh
```

`open` 已经默认等待 `stable`，常规流程不要再补一条 `await stable`。只有 `open` 返回 `RUNTIME_UNSTABLE`，或你明确看到 DevTools 还在编译/刷新时，才继续执行 `miniprogram-browser await stable --session feat-a`。

如果 fresh 启动阶段你或人类已经**肉眼看到小程序页面出来了**，但 `open` 还没成功，不要立刻再次 `--fresh`。优先采用下面这个顺序：

1. 先静置一次短等待，让 DevTools 自己把编译 / AppService / cli server 收尾
2. 再重跑同一个 `open`，但**不带** `--fresh`
3. 如果 session 还在，再补 `await app-ready` / `await stable`

参考写法：

```bash
miniprogram-browser open --session feat-a --project /path/to/miniprogram-root --fresh

# 如果刚才页面已经显示，但 open 仍失败，不要继续 fresh 循环
sleep 8
miniprogram-browser open --session feat-a --project /path/to/miniprogram-root

# 如果 session 还在
miniprogram-browser await app-ready --session feat-a
miniprogram-browser await stable --session feat-a
```

如果 DevTools 弹出“允许该项目 / 信任项目”确认框：

- 先把它理解成 DevTools 项目安全校验，不是业务页面里的弹窗
- `miniprogram-browser` 默认已经传 `--trust-project`；如果当前 DevTools 版本仍弹窗，说明这次启动没有被工具自动吸收
- 这类确认目前不要靠 agent 猜测或硬等；应由人类确认一次
- 确认后优先重新执行同一个 `open`；如果 session 已保留，也可以先执行 `await app-ready` 或 `doctor`
- WSL 下优先用 `/mnt/<drive>/...` 项目路径；attach 到已有 live runtime 往往比反复 `--fresh` 更稳定

如果本地 shell 已经设置了 `WECHAT_DEVTOOLS_CLI`，就不需要重复 `export`。

如果当前环境还没安装 CLI，也可以改用：

```bash
npx miniprogram-browser help
```

完整命令清单以 CLI 自带帮助为准。

## 等待策略

优先级固定如下：

1. 业务命令直接挂 `--await`
2. 需要分步探测时用显式 `await <condition>`
3. `wait` 只做最后兜底

常见写法：

```bash
miniprogram-browser await app-ready --session feat-a
miniprogram-browser await stable --session feat-a
miniprogram-browser goto /pages/order/detail --session feat-a --await route:/pages/order/detail
miniprogram-browser click @e12 --session feat-a --await route-settled
miniprogram-browser screenshot --session feat-a --mode layout --await visible:.page-root
miniprogram-browser wait 1200 --session feat-a
```

建议：

- `open` 默认等待 `stable`：App runtime 响应、当前页路径/页面栈短暂稳定，并尝试读取通用视图树
- 如果 `open` 报 `RUNTIME_UNSTABLE`，不先重启；优先继续 `await stable --session <name>`，再用 `doctor` / `devtools logs` 判断是否真的失败
- 如果 fresh 启动失败，但人类已经看到页面显示出来，先等 5 到 10 秒，再重跑同一个 `open`，优先复用现有 runtime，不要立刻继续 `--fresh`
- 如果 `open` 期间出现 DevTools 项目信任确认框，先由人类确认，再重试同一个 `open` 或继续 `await app-ready`
- 如果 fresh 启动已经显示 `Using AppID: ...`，但后续仍连不上 automation，这通常不是路径或 AppID 问题，而是 DevTools 自身的 `cli server` / 编译链路仍未起来
- 如果 agent 自己无法判断页面是否真的已显示，可以直接让人类确认“页面已显示 / 仍在白屏”；这比盲目重复启动更稳定
- `goto/click/native/screenshot/snapshot` 优先写 `--await`
- 不要把 `wait 3000` 当主路径；只有找不到合适条件时才退回固定毫秒

## 跨平台路径策略

`miniprogram-browser` 的默认目标是让 agent 在 macOS、Windows、WSL 下使用同一套心智：

- `--project` 始终写当前 shell 可读的小程序根目录
- macOS / Windows / WSL `/mnt/*` 路径由 CLI 自动转成 DevTools 可接受的路径
- WSL 推荐把项目放在 `/mnt/<drive>/...`；`/home/...` 不再做受控镜像复制
- 不要为了路径问题回退到 GUI 截图、OCR、PowerShell 控窗

WSL 日常推荐：

```bash
miniprogram-browser open \
  --session feat-a \
  --project /mnt/d/work/demo/apps/miniprogram
```

### 高级路径兜底

当自动路径策略不够用时：

```bash
miniprogram-browser open \
  --session feat-a \
  --project /home/wang/work/demo/apps/miniprogram \
  --devtools-project 'P:\work\demo\apps\miniprogram'
```

如果多个项目共享同一个 WSL 前缀，可以配置显式前缀映射：

```bash
export WECHAT_DEVTOOLS_PROJECT_MAP='/home/wang/work=P:\work;/home/wang/tmp=T:\tmp'
```

这些兜底只影响传给微信开发者工具 CLI 的项目路径；`--project` 仍负责本地静态扫描、session 归属和截图产物定位。不要把 Windows 盘符路径直接塞进 WSL 下的 `--project`。

## Session 语义

**session** 是用户/agent 的工作上下文；**runtime** 是 DevTools 自动化连接。

session 持久化大致包括：

- `projectPath`
- `route` / refs / logs 等用户状态

**不**固化在 session 文件中：

- `autoPort` / `devtoolsPort`（运行时资源，存在 runtime 池；成功连接时仍会回显）

规则：

- 可省略 `--session`：按项目自动生成/复用 `{project}-xN`（如 `earlyriser-x1`）；`open --fresh` 且未显式 session 时分配下一个 `xN`
- 显式 `--session work` 等仍用于并行工作台；**不要**用全局 `default`
- `--project` 可由当前目录/Git 工作树自动发现
- fresh session 下，`autoPort` 默认自动分配；调用方通常不需要传端口
- 本机 DevTools 的 `auto -h` 可能不显示 `--auto-port`，但 CLI 实际仍支持并透传给 `/auto`
- 显式 `--auto-port` 只用于调试/指定端口；后续命令会从 runtime 池按 session 回绑 live 端口
- `devtoolsPort` 默认不作为隔离边界；CLI 会让 DevTools 回显/沿用当前 HTTP 服务端口
- 只有在明确排查 DevTools HTTP 服务端口时，才显式传 `--devtools-port`
- 仅知道 `devtoolsPort` 只代表 DevTools HTTP 服务活着，不代表当前小程序 runtime 已可 attach；手工打开的小程序要先用 `doctor --project <path> --devtools-port <port>` 做 bootstrap 预检
- `open` 的默认语义是“确保拿到一个可用 session”：优先 attach 到同项目唯一 live runtime；没有可复用 runtime 时才尝试启动新的
- `open` 成功前会尽量做通用稳定验收；如果 Tool 层已连通但 App 仍在 warmup，`open` 会返回 `appReady=false`，session 保留，后续显式执行 `await app-ready`
- 如果当前项目还没有已启动的小程序 runtime，attach 不会发生，`open` 会直接走启动路径
- 同项目存在多个 live runtime 时不会静默选择；请显式使用目标 `--session`，或传 `--fresh` 尝试启动新 runtime
- `--fresh` 表示“必须新起”；失败时不会偷偷降级成 attach
- `open --fresh` 如果在启动阶段失败，会优先尝试关闭这次拉起的 DevTools 项目，并清理本次新建的 session/launch 记录；已存在的旧 session 不会被静默删除
- DevTools debug 里的 `ws connect <port>` 是 CLI 自己的 `/upgrade` 长连接端口，不是 automation ws 端口
- 如果你显式传了端口，CLI 会校验 `autoPort` 冲突；不会静默抢占其他 session
- 同一个 `session` 内部会串行化；不同 `session` 可以并发
- 共享同一 `autoPort` 的多个 session 还会经过 runtime 级锁串行执行，避免两个 agent 同时操作同一小程序实例
- 多 worktree / 多分支并行时，每个 worktree 用独立 `session`；默认 session 发现会按当前 Git 工作树识别项目，不跨到无关父目录
- 用完后执行 `close --session <name>`；attached session 默认只解绑自己，不关闭 owner runtime
- 只有 owner session 或显式 `--runtime` 才关闭底层 DevTools runtime
- `open` 如果自己新启动 runtime，会先登记一个项目级 launch record；底层启动失败/连接失败时会按该记录尝试 `close --project` 收尾，避免失败后丢失清理线索
- 如果已经连上但只是 `stable` 超时，不会立刻关闭 runtime；这类情况通常可以继续等待或诊断
- `session prune` 只清理当前项目 stale session 和本 CLI 记录的 orphan launch；会尝试关闭对应 DevTools 项目窗口，不会全局扫其他项目
- `session list` 默认只列当前项目；找不到当前项目时默认返回空并提示，避免泄漏全局旧 session
- `session list --all` 是显式全局查看入口
- `session kill <name>` / `session close <name>` 会优先终止当前项目下的同名 session，不会清理其他项目

### 当前项目发现

常规命令绑定后通常只需要传 `--session`。CLI 会从当前目录推导项目作用域：

- 当前目录本身是小程序项目时，直接使用它
- 当前目录在同一个 Git 工作树的 sibling 目录里时，尝试发现唯一的 `apps/miniprogram` 或 `miniprogram`
- 一旦发现 Git 工作树边界，就不会继续向父目录外查找，避免选中无关仓库

注意：如果项目发现失败，首次 `open/connect` 仍应显式传 `--project`，这样 session 归属对调用方是清晰的。

### 多 session 与失败回显

同一个项目可以打开多个 session，例如并行分析两个小程序实例。默认每个 fresh session 使用独立的 `autoPort` 和独立 session 状态；DevTools HTTP 端口通常由当前 DevTools 服务统一承载。

日常默认不是强行 fresh，而是优先复用唯一 live runtime：

```bash
miniprogram-browser open --session agent-task-a
```

如果当前项目只有一个 live runtime，输出会包含：

- `mode=attached`
- `attachedTo=<owner-session>`
- `autoPort=<owner-auto-port>`

如果你确实要尝试新开 runtime，再显式传：

```bash
miniprogram-browser open --session agent-task-a --fresh
```

如果你显式传了 `--auto-port`，应把它理解成 fresh 启动时的 automation 端口请求；attach 到已有 runtime 时不会强行改绑 owner 的 `autoPort`。

如果新 session 等待超时，CLI 不会静默复用其他 session；错误会优先回显：

- 短 `code`
- 一句 `message`
- 一条事实型 `hint`
- 一条相关 `log`
- 最小化的项目级 `diagnostics`

这样 agent 可以先判断是路径策略、autoPort，还是同项目已有 live session 在干扰。

## 诊断与逃逸点

### 推荐诊断

- `app inspect`：应用结构摘要
- `doctor`：分层诊断 DevTools CLI、automation WebSocket 和小程序 App runtime
- `devtools logs`：读取微信开发者工具 `WeappLog` 底层日志；用于 App runtime 不响应、普通 `logs` / `exceptions` 拿不到信息时
- `timeline`：路由变化时间线
- `logs` / `exceptions`：运行时输出与异常；优先用它们理解当前页面的数据加载、报错、按钮点击后发生了什么
- `system-info` / `page-stack`：设备与页面栈

典型诊断流程：

```bash
miniprogram-browser app inspect --session feat-a
miniprogram-browser doctor --session feat-a --json
miniprogram-browser logs --session feat-a --limit 20
miniprogram-browser exceptions --session feat-a
miniprogram-browser timeline --session feat-a
miniprogram-browser devtools logs --session feat-a --limit 40 --grep "appservice|simulator|error"
```

使用建议：

- 看到“页面没反应 / 不确定按钮是否生效”时，不要只盯截图；先看 `logs` / `exceptions`
- 如果 `doctor` 显示 Tool 层可达但 App runtime 不响应，优先看 `devtools logs`，不要回退到 Windows GUI 截图/OCR
- `doctor` 的 `startupIssue` 更适合作为“最近一次相关启动线索”；如果你需要判断 fresh 启动为什么失败，以同次 `open --fresh` 返回的 `code / hint / log` 为准
- 对数据加载页、表单页、工具页，console 往往比截图更早暴露真实状态
- 如果 `logs` 已经明确报错，再去看 layout / snapshot 会更容易判断问题归因

### 底层逃逸点

`protocol <method> [json]` 是自动化 WebSocket 的底层调用口，例如 `Tool.getInfo` 或 `App.callWxMethod`。它只用于极端排障，不作为常规操作入口；常规操作仍优先使用 `snapshot/click/fill/get/logs/exceptions`。

## Taro / H5 浏览器渲染（可选高保真视觉工作流）

如果当前项目是跨端 Taro 项目，并且已经有可用的 H5 输出，这时可以把浏览器渲染作为**辅助视觉工作流**：

- 用浏览器拿更高保真的视觉截图
- 用 `miniprogram-browser` 拿真实小程序运行时结构、ref、logs、exceptions
- 两条证据线结合，而不是只信其中一条

适用场景：

- 你需要更像真实页面的视觉留证
- DevTools 真实截图通道不稳定，但 H5 端可正常运行
- 你想核对复杂样式、间距、字体、阴影等视觉细节

不适用场景：

- 你要证明微信小程序专属能力或原生组件行为
- 页面强依赖 `wx` 能力，H5 端并没有完整实现
- 你想把浏览器截图当成“小程序真实截图”的替代证据

推荐步骤：

1. 先在小程序里读取当前视觉尺寸：

```bash
miniprogram-browser system-info --session feat-a
```

重点看：

- `windowWidth`
- `windowHeight`
- `pixelRatio`

2. 再把浏览器/H5 的 viewport 固定成同样尺寸，尽量对齐视觉基线

推荐移动基线：

- 主基线：`375 x 812`
- 大屏补充：`414 x 896`
- DPR 建议 `2` 或 `3`

3. 浏览器端只负责**视觉截图**，小程序端继续负责：

- `logs` / `exceptions`
- `snapshot -i`
- `snapshot -i --layout`
- `screenshot --mode layout`

4. 最终判断时遵循：

- 浏览器图更偏视觉
- 小程序图更偏真实运行时
- 结论冲突时，优先继续看小程序运行时证据

重要边界：

- 浏览器渲染不是小程序运行时等价物
- 它可以帮助看“样子”，但不能替代小程序里的行为证据
- 如果只是做结构分析，优先 `screenshot --mode layout`；不要因为有浏览器就跳过小程序取证

### 逃逸点

当 `snapshot/click/fill/get` 不够用时，再退到：

- `eval` / `eval --stdin`
- `native <method> [...args]`
- `get attr|get prop|get rect`
- `call wx` / `call page`

原则：

1. 标准层命令优先
2. 标准层不够时，再用逃逸点
3. 用完后尽量回到 ref/语义命令

### 辅助命令（query / within / relaunch）

- `query <mode> <value>`：按 `selector | text | business` 查询节点；先用它快速定位，再切到 ref 语义命令
- `within <ref> <command> ...`：在 ref 作用域内继续执行子命令，例如只在某个列表项内 `click`；子命令仍走同一 session
- `relaunch <route>`：重启到指定路由，等价于冷启动后 `goto`

## app inspect

`app inspect` 默认只给摘要，不直接吐完整应用图。

默认摘要包含：

- `pagesSummary`
- `tabBarSummary`
- `current`
- `pageStack`
- `recentRoutes`
- `currentOutgoingEdges`
- `staticSummary`

更详细时再用：

- `--sections a,b,c`
- `--all`

## screenshot

对 agent 而言，推荐顺序通常是：

1. `snapshot -i`（非识图模型默认：结构化 ref 文本树 + ASCII 空间图，零真实像素）
2. `--mode layout`
3. `snapshot -i --layout`
4. `--mode annotate`
5. `--mode page` / `--mode visual`

原因：`layout` 更稳定，也更适合把结构、层次和 focus 交给模型分析；真实像素截图更适合留证或核对视觉细节。

补充边界：

- `page/visual/annotate` 这些真实像素截图，本质上依赖开发者工具模拟器截图通道
- 它们不等价于真机画面，也不适合在截图通道已经不稳定时反复硬试
- `layout` 不依赖真实像素截图通道，更适合作为默认分析入口

支持四种模式：

- `--mode layout`：结构化布局图，默认模式，优先推荐给 agent
- `--mode page`：官方页面截图
- `--mode visual`：页面截图 + 胶囊视觉合成
- `--mode annotate`：页面截图 + `@eNN` 标注叠加
- `--focus @e1,@e2`：对指定 ref 叠加高亮框，支持多元素自动换色；当前样式是高对比配色 + 双层边框 + 轻纹理填充
- `--no-ref`：隐藏截图里的 `@eN` 标签；适合只看结构或汇报图

默认模式是 `layout`。

保存方式：

- 不传路径：保存到默认截图目录（当前仓库默认是 `artifacts/screenshots`）
- 传路径(优先推荐策略)：保存到显式指定的位置(推荐放在.artifacts/{时间戳}-{session}里)，方便后续查看和关联日志/trace.

如果你主要是为了让模型理解页面，不要默认先追求真实截图；优先走 `screenshot --mode layout`。如果真实截图偶发超时，优先切到 `--mode layout`，其次才是 `snapshot -i --layout`。不要把 `close/open` 或重启 DevTools 当默认修复手段；只有在不同 session / 项目都持续超时时，再把完全重启 DevTools 当成最后手段。

截图前的通用建议：

1. 每次 `goto / click / fill / call / native` 后优先 `--await`
2. 截图前先 `path`、`app inspect` 或 `snapshot -i` 确认页面已经稳定
3. 如果只是看结构，不要继续硬试真实截图，直接切 `--mode layout`

`--focus` 的推荐用法：

1. 先 `snapshot -i` 拿当前页面的 ref
2. 再 `screenshot --focus @e1,@e2`
3. 如果需要更简洁视图，可以先看 `snapshot -i -c`；但 compact 现在只是同一套 ref 的子集，不会再重新编号

## 稳定 CLI 面（公共契约）

权威细节：仓库 `.trellis/spec/cli/product-contracts.md`。

- **公共 API = CLI 命令**，不是 `dist/lib/**` 的 Node require 面
- **L0 主路径（优先）**：`open` / `snapshot` / `click` / `fill` / `get` / `goto` / `await` / `close` / `session` / `path`
- **L1 诊断**：`doctor` / `logs` / `exceptions` / `timeline` / `devtools logs` / `app inspect`
- **L2 逃逸**：`protocol` / `eval` / `native` / `call` / `query` / `within` / 高级 `screenshot`
- 成功时关注：`session`、`path`、`mode`、`autoPort`、`project`（其余为观测扩展）
- 失败时：读人话 + 保留的底层 raw；不要假设一定有 `code` / `next`

## Ref 使用边界（`@e` 硬规则）

`@eN` 是 **当前 session 内、以 snapshot 为界的可解析句柄**。实现会用 stableKey **尽力**跨 snapshot 复用同号，但：

**不是**全局永久 ID，**不是**跨 session ID，**不是**「永远是保存按钮」的业务主键。

硬规则（必须遵守）：

1. **先 `snapshot -i`（或本轮已产出 refs 的查询），只用本轮输出里的 `@eN`。**
2. **页面可能变化后（导航、列表刷新、弹层开关、明显重渲染）必须重新 `snapshot -i`，不得沿用旧号碰运气。**
3. **路由变了 → 旧页 `@e` 全部作废**；出现 route mismatch 时重新 snapshot。
4. **stale / unknown ref / selector 失效 → 禁止重试同一旧 `@e`**；重新 `snapshot -i` 再操作。
5. **`@e` 仅在产生它的 session 内有效**；换 session 必须重新 snapshot。
6. **ASCII 图中的数字 = `@eN` 的 N**；命令仍写 `@e23` 这种完整形式。读文案看语义树，不看图内文字（图默认不渲染文案）。

补充：

- `snapshot -i -c` 更紧凑，但 ref 与普通快照同一套 identity，不会因 compact 单独重编号
- `snapshot -i --layout` 附加比例 rect，便于纯文字布局分析
- 业务若要跨会话稳定定位，应在小程序侧提供 testid / businessKey，而不是神化 `@e` 编号

## 常见误区

- 误以为 `open` 是打开页面 URL；它的本质是绑定实例
- 误以为 `open` 成功就代表当前页已经对了；应先 `path` 或 `app inspect`
- 误以为可以默认猜项目目录；`--project` 必须是当前 shell 可读的小程序项目根目录（或 cwd 唯一发现）
- 误以为 WSL 下可以把 Windows 盘符路径直接塞进 `--project`；默认仍传 Linux 路径，必要时用 `--devtools-project` 或 `--project-map` 指定 DevTools 侧路径
- 误以为登录过期还能继续自动化；需在 DevTools 重新登录，CLI 会保留底层原始错误
- 误以为 session 文件会长期固化 `autoPort`；端口在 runtime 池，成功连接时回显，后续命令自动回绑
- 误以为 `@eN` 是永久 ID 或跨页/跨 session 仍有效；见上方硬规则
- 误以为 ASCII 图上的 `3` 是「第三项」而不是 `@e3`；图上数字只是编号 N
- 误以为 `snapshot -i` 需要业务自己提供 tree；不需要
- 误以为 `timeline` 是截图历史；它记录的是路由事件，不是视觉历史
- 误以为 `eval` 等价于浏览器 DOM 脚本；这里执行的是小程序 AppService 运行时
- 误以为 `native` 是普通 click；它走的是开发者工具暴露的原生控制通道
- 误以为 debug 日志里的 `ws connect <port>` 就是 automation ws；实际那是 CLI 自己的 `/upgrade` 长连接
- 误以为 session 名不同就一定隔离；不要依赖抢占不同 `devtoolsPort` 来做多分支并行
- 误以为很多操作可以无间隔链起来；优先写 `--await`，只有没有合适条件时才退回 `wait`
- 误以为应 `require` 包内 `dist/lib/*` 当 SDK；公共面是 CLI
