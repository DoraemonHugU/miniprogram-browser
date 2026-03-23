---
name: miniprogram-browser
description: 当想要在微信开发者工具里用接近 agent-browser 的方式操作小程序时加载。
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

- `projectPath` 必须是**开发者工具实际打开的项目根目录**
- 它不是浏览器 DOM 自动化，部分自定义组件在运行时里可能不透明

不要用它做上传、预览、发布、CI 打包；那属于 `miniprogram-ci`。

## 何时使用

- 想用 `snapshot -i`、`@e1`、`click`、`fill`、`get text` 这类 agent-friendly 命令
- 想优先走稳定 ref，而不是手写脆弱的 class 链或 nth 选择器
- 想查看当前页面状态、路由变化、日志、异常、应用结构摘要

## 核心心智

1. `open` 绑定的是一个**小程序实例**，不是页面 URL
2. 绑定后先 `path` 或 `app inspect` 确认当前状态
3. 再 `goto` 到目标路由(默认首页)
4. 优先用 `screenshot --mode layout` 理解页面结构
5. 需要纯文字布局或比例 rect 时，再用 `snapshot -i --layout`
6. 需要稳定 ref 时，再 `snapshot -i` 生成 `@eN` refs
7. 只有在确实需要真实像素证据时，再退回 `page/visual/annotate`
8. 页面明显变化后，重新 `snapshot -i`

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
miniprogram-browser goto /pages/dashboard/index --session feat-a
miniprogram-browser screenshot artifacts/layout.png --session feat-a --mode layout --no-ref
miniprogram-browser snapshot -i --layout --session feat-a
miniprogram-browser screenshot artifacts/layout-focus.png --session feat-a --mode layout --focus @e16,@e17
miniprogram-browser snapshot -i --session feat-a
miniprogram-browser click @e1 --session feat-a
miniprogram-browser timeline --session feat-a
miniprogram-browser screenshot --session feat-a --mode annotate
miniprogram-browser close --session feat-a

miniprogram-browser help
```

如果本地 shell 已经设置了 `WECHAT_DEVTOOLS_CLI`，就不需要重复 `export`。

如果当前环境还没安装 CLI，也可以改用：

```bash
npx miniprogram-browser help
```

完整命令清单以 CLI 自带帮助为准。

## Session 语义

一个 session 绑定的是：

- `projectPath`
- `devtoolsPort`
- `autoPort`

规则：

- 首次 `open/connect` 必须显式传 `--session` 和 `--project`
- fresh session 下，`devtoolsPort` 和 `autoPort` 都可以自动分配
- 但如果 DevTools 已经作为一个 live 实例跑在某个 HTTP 端口上，工具不会静默把它改到另一个端口；这时应复用当前 session/端口，或先手动重启 DevTools 服务端口
- 同一个 session 内部会串行化，不需要调用方自己做并发控制
- 多 worktree 并行时，每个 worktree 用独立的 `session + devtoolsPort`
- 用完后执行 `close --session <name>`，关闭对应 DevTools 实例并解绑
- `session list` 可以查看当前已绑定列表

## 诊断与逃逸点

### 推荐诊断

- `app inspect`：应用结构摘要
- `timeline`：路由变化时间线
- `logs` / `exceptions`：运行时输出与异常
- `system-info` / `page-stack`：设备与页面栈

典型诊断流程：

```bash
miniprogram-browser app inspect --session feat-a
miniprogram-browser timeline --session feat-a
miniprogram-browser logs --session feat-a --limit 20
miniprogram-browser exceptions --session feat-a
```

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

1. 每次 `goto / click / fill / call / native` 后适度 `wait`
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
- 误以为可以默认猜项目目录；`--project` 必须是开发者工具实际打开的项目根目录
- 误以为 `snapshot -i` 需要业务自己提供 tree；不需要
- 误以为 `timeline` 是截图历史；它记录的是路由事件，不是视觉历史
- 误以为 `eval` 等价于浏览器 DOM 脚本；这里执行的是小程序 AppService 运行时
- 误以为 `native` 是普通 click；它走的是开发者工具暴露的原生控制通道
- 误以为 session 名不同就一定隔离；当前更可靠的隔离边界是 `projectPath + autoPort`，不要依赖抢占不同 `devtoolsPort` 来做多分支并行
- 误以为很多操作可以无间隔链起来；当前截图链路更稳妥的方式是每步后适度 `wait`
