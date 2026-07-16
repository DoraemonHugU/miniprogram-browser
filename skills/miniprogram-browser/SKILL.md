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

它适合让 agent 直接操作微信小程序，但要记住两点：

- `--project` 指向 agent 当前系统可读的小程序项目根目录；当前目录或同 Git 工作树能唯一发现项目时可以省略
- DevTools 实际接收的项目路径由 CLI 按平台自动推导；WSL `/home` 场景会在显式 `open/doctor` 时创建受控 Windows 临时镜像
- 它不是浏览器 DOM 自动化，部分自定义组件在运行时里可能不透明

不要用它做上传、预览、发布、CI 打包；那属于 `miniprogram-ci`。

## 何时使用

- 想用 `snapshot -i`、`@e1`、`click`、`fill`、`get text` 这类 agent-friendly 命令
- 想优先走稳定 ref，而不是手写脆弱的 class 链或 nth 选择器
- 想查看当前页面状态、路由变化、日志、异常、应用结构摘要

## 核心心智

1. `open` 绑定的是一个**小程序实例**，不是页面 URL
2. `open` 默认会等待通用稳定条件；超时不一定代表小程序已失败，可能只是还在编译/刷新，可继续用 `await stable` 或 `doctor` 判断
3. fresh 启动默认会先让 DevTools 显式 `open project`，再开启 automation；常规使用不要自己再额外手拼一条 `cli open`
4. 绑定后先 `path` 或 `app inspect` 确认当前状态
5. 再 `goto` 到目标路由；页面跳转或点击后优先用 `--await`，不要先猜固定毫秒
6. 先用 `logs` / `exceptions` 看运行时输出，理解小程序当前发生了什么
7. 优先用 `screenshot --mode layout` 理解页面结构
8. 需要纯文字布局或比例 rect 时，再用 `snapshot -i --layout`
9. 需要稳定 ref 时，再 `snapshot -i` 生成 `@eN` refs
10. 只有在确实需要真实像素证据时，再退回 `page/visual/annotate`
11. 页面明显变化后，重新 `snapshot -i`

如果你的目标是让模型稳定理解页面结构，优先使用：

```bash
miniprogram-browser screenshot out.png --session feat-a --mode layout --focus @e20,@e21
miniprogram-browser screenshot out.png --session feat-a --mode layout --no-ref
miniprogram-browser screenshot out.png --session feat-a --mode layout -c --capsule
```

如果需要纯文字布局信息，再使用：

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

miniprogram-browser open --session feat-a --project /path/to/miniprogram-root
miniprogram-browser app inspect --session feat-a
miniprogram-browser logs --session feat-a --limit 20
miniprogram-browser exceptions --session feat-a
miniprogram-browser goto /pages/dashboard/index --session feat-a --await route:/pages/dashboard/index
miniprogram-browser screenshot artifacts/layout.png --session feat-a --mode layout --await route-settled --no-ref
miniprogram-browser snapshot -i --layout --session feat-a --await route-settled
miniprogram-browser screenshot artifacts/layout-focus.png --session feat-a --mode layout --await route-settled --focus @e16,@e17
miniprogram-browser snapshot -i --session feat-a
miniprogram-browser click @e1 --session feat-a --await route-change
miniprogram-browser timeline --session feat-a
miniprogram-browser screenshot --session feat-a --mode annotate
miniprogram-browser session prune
miniprogram-browser close --session feat-a

miniprogram-browser help
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
- WSL `/home/...` fresh 启动时，DevTools 可能把新的受控镜像路径视为新项目；attach 到已有 live runtime 往往比反复 fresh 更稳定

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
- WSL `/home/...` 项目默认创建受控 Windows 临时镜像，再把该本地盘路径传给 DevTools
- 不要为了路径问题回退到 GUI 截图、OCR、PowerShell 控窗

WSL `/home/...` 项目的日常用法仍然只有一个参数：

```bash
miniprogram-browser open \
  --session feat-a \
  --project /home/wang/work/demo/apps/miniprogram
```

受控镜像的边界：

- 不做后台循环，不做文件监听，不在普通 `path/snapshot/click/logs` 命令里刷新镜像
- 只写入路径形如 `%TEMP%\miniprogram-browser\project-<hash>` 的受控目录
- 受控目录内带 `.miniprogram-browser-managed` 标记文件
- `close --session <name>` 只清理该 session 记录、带标记且目标匹配的受控镜像
- 镜像排除 `node_modules` 和 `.git`
- 不删除用户显式传入的 DevTools 项目路径
- 不删除 Windows 盘符路径、不删除项目目录、不清理任意 temp 目录
- `open/doctor --json` 会输出 `projectStrategy` 和 DevTools 实际项目路径，不做黑盒切换

### 高级路径兜底

只有 CLI 明确报告自动镜像不可用时，才使用这些兜底能力：

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

一个 session 绑定的是：

- `projectPath`
- `devtoolsProjectPath`（可选，仅 DevTools CLI 使用）
- `devtoolsPort`
- `autoPort`

规则：

- 首次 `open/connect` 必须显式传 `--session`；`--project` 可由当前目录/Git 工作树自动发现
- fresh session 下，`autoPort` 默认自动分配，调用方通常不需要传端口
- 本机 DevTools 的 `auto -h` 可能不显示 `--auto-port`，但 CLI 实际仍支持并透传给 `/auto`
- 显式 `--auto-port` 只用于 fresh 启动；attach 到已有 runtime 时会沿用 owner `autoPort`
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
- `session prune` 只清理当前项目 stale session 和本 CLI 记录的 orphan launch；它会尝试关闭对应 DevTools 项目窗口并删除受控镜像，不会全局扫其他项目
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

1. `--mode layout`
2. `snapshot -i --layout`
3. `--mode annotate`
4. `--mode page` / `--mode visual`

原因：`layout` 更稳定，也更适合把结构、层次和 focus 交给模型分析；真实像素截图更适合留证或核对视觉细节。

补充边界：

- `page/visual/annotate` 这些真实像素截图，本质上依赖开发者工具模拟器截图通道
- 它们不等价于真机画面，也不适合在截图通道已经不稳定时反复硬试
- `layout` 不依赖真实像素截图通道，更适合作为默认分析入口

支持四种模式：

- `--mode layout`：结构化布局图，优先推荐给 agent
- `--mode page`：官方页面截图
- `--mode visual`：页面截图 + 胶囊视觉合成
- `--mode annotate`：页面截图 + `@eNN` 标注叠加
- `--focus @e1,@e2`：对指定 ref 叠加高亮框，支持多元素自动换色；当前样式是高对比配色 + 双层边框 + 轻纹理填充
- `--no-ref`：隐藏截图里的 `@eN` 标签；适合只看结构或汇报图

默认模式是 `page`。

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

## Ref 使用边界

- ref 代表“可重解算的节点身份”，不是旧元素句柄
- 页面明显变化后，重新执行 `snapshot -i`
- 如果当前路由和 ref 绑定路由不一致，应重新 query 或 snapshot
- `snapshot -i -c` 只是更紧凑的显示方式；compact 视图中的 ref 现在会复用普通快照里的同一 identity
- `snapshot -i --layout` 会附加比例 rect；适合让模型做纯文字布局分析

## 常见误区

- 误以为 `open` 是打开页面 URL；它的本质是绑定实例
- 误以为 `open` 成功就代表当前页已经对了；应先 `path` 或 `app inspect`
- 误以为可以默认猜项目目录；`--project` 必须是当前 shell 可读的小程序项目根目录
- 误以为 WSL 下可以把 Windows 盘符路径直接塞进 `--project`；默认仍传 Linux 路径，自动镜像不可用时才使用 `--devtools-project` 或 `--project-map`
- 误以为 `snapshot -i` 需要业务自己提供 tree；不需要
- 误以为 `timeline` 是截图历史；它记录的是路由事件，不是视觉历史
- 误以为 `eval` 等价于浏览器 DOM 脚本；这里执行的是小程序 AppService 运行时
- 误以为 `native` 是普通 click；它走的是开发者工具暴露的原生控制通道
- 误以为 debug 日志里的 `ws connect <port>` 就是 automation ws；实际那是 CLI 自己的 `/upgrade` 长连接
- 误以为 session 名不同就一定隔离；不要依赖抢占不同 `devtoolsPort` 来做多分支并行
- 误以为很多操作可以无间隔链起来；优先写 `--await`，只有没有合适条件时才退回 `wait`
