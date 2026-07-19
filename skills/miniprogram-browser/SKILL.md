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

- `--project` 指向当前系统可读的小程序项目根目录；当前目录或同 Git 工作树能唯一发现项目时可以省略
- 传给微信开发者工具的项目路径由 CLI 按平台自动处理（macOS/Windows 通常可直接用；WSL 下 `/mnt/<盘符>/...` 会自动转成对应盘符路径；不够用时再用 `--devtools-project` / `--project-map`）
- 必须已登录微信开发者工具；登录过期时无法自动化，错误里会保留开发者工具侧的原始信息
- 它不是浏览器 DOM 自动化，部分自定义组件在运行时里可能不透明

不要用它做上传、预览、发布、CI 打包；那属于 `miniprogram-ci`。

完整命令清单以 CLI 自带帮助为准：`miniprogram-browser help` / `help <command>`。

## 何时使用

- 想用 `snapshot -i`、`@e1`、`click`、`fill`、`get text` 这类 agent-friendly 命令
- 想优先走 ref，而不是手写脆弱的 class 链或 nth 选择器
- 想查看当前页面状态、路由变化、日志、异常、应用结构摘要

## 模型分派：非识图 vs 识图

- **非识图模型（纯文本/结构化推理）**：默认用 `snapshot -i`。输出结构化 ref 文本树 + 紧凑 ASCII 空间图，不依赖真实截图通道。
- **识图模型（能直接看图片）**：确实需要真实像素证据时，用 `screenshot --mode page|visual|annotate`。`screenshot` 默认 `mode` 为 `layout`（结构布局图，同样不依赖不稳定的官方页面截图）；要真实像素请显式 `--mode page|visual|annotate`。
- 不要把 `snapshot` 当真实截图工具：它默认只给结构化树 + ASCII 空间图；要真实像素走 `screenshot --mode page|visual|annotate`，或 `snapshot -i --visual`。

## 核心心智

1. `open` 绑定的是一个**小程序工作会话（session）**，不是浏览器 URL
2. 同一项目下，`open` 默认会尽量复用已经可用的开发者工具实例；只有没有可复用实例，或你显式 `--fresh` 时，才会尝试新开
3. `open` 默认会等待通用稳定条件；超时不一定代表小程序已失败，可能只是还在编译/刷新，可继续用 `await stable` 或 `doctor` 判断
4. 常规使用不要自己再手拼开发者工具的 `cli open`；路径、信任项目、端口等由本 CLI 处理
5. 绑定后先 `path` 或 `app inspect` 确认当前状态
6. 再 `goto` 到目标路由；页面跳转或点击后优先用 `--await`，不要先猜固定毫秒
7. 先用 `logs` / `exceptions` 看运行时输出，理解小程序当前发生了什么
8. 非识图模型优先 `snapshot -i`：结构化 ref 树 + ASCII 空间图
9. 需要纯文字比例位置时，用 `snapshot -i --layout`（为每个 ref 附带 x/y/w/h 百分比）
10. 识图模型、且确实需要真实像素时，用 `screenshot --mode page|visual|annotate`
11. **页面明显变化后，重新 `snapshot -i` 再使用新的 `@eN`**

理解页面结构时优先：

```bash
miniprogram-browser snapshot -i
miniprogram-browser snapshot -i --no-map
miniprogram-browser screenshot out.png --mode layout --focus @e20,@e21
miniprogram-browser screenshot out.png --mode layout --no-ref
miniprogram-browser screenshot out.png --mode layout -c --capsule
```

`snapshot -i` 默认两部分，用同一套 `@eN` 交叉引用：

- **语义树**：层级 + `@eN` + 控件类型 + 文案（操作与读字以这里为准）
- **ASCII 空间图**：帮助判断大致布局；图中数字对应 `@eN` 的编号（如 `23` → `@e23`）；较大区域/控件会有边框，过小的只标数字；`*` 表示多个编号挤在同一位置。不需要图时用 `--no-map`

需要纯文字比例 rect 时：

```bash
miniprogram-browser snapshot -i --layout
```

`layout` 截图模式会：

- 默认用语义布局层画结构图
- `-c/--compact` 更紧凑
- `--raw` 更底层的运行时节点布局
- 支持 `--focus` 高亮、`--no-ref` 隐藏图上的 `@eN` 标签
- 可选 `--capsule` 叠加右上角微信胶囊样式

## 最常用流程

```bash
# 若本机未配置开发者工具 CLI 路径，再设置（路径按本机安装位置修改）
export WECHAT_DEVTOOLS_CLI=/path/to/cli

# 最短路径：可省略 --session（会按项目自动生成/复用类似 myapp-x1 的名字）
miniprogram-browser open --project /path/to/miniprogram-root
miniprogram-browser snapshot -i
miniprogram-browser click @e1 --await route-change

# 需要并行工作台时再显式命名
miniprogram-browser open --session work --project /path/to/miniprogram-root
miniprogram-browser open --session debug --project /path/to/miniprogram-root --fresh
```

先 `open` 再操作：`snapshot` / `click` / `goto` 等会复用已建立的自动化连接；**不会**在未 open 时默默再跑一轮完整 `auto`。若提示「自动化未连接」，请先 `open`。

`open` 已经默认等待 `stable`，常规流程不要再补一条 `await stable`。只有 `open` 返回 `RUNTIME_UNSTABLE`，或你明确看到开发者工具还在编译/刷新时，才继续：

```bash
miniprogram-browser await stable --session <name>
```

如果 `--fresh` 启动时人已经**看到小程序页面出来了**，但 `open` 仍失败，不要立刻再次 `--fresh`。优先：

1. 短等几秒，让开发者工具收尾编译
2. 再跑同一个 `open`（**不带** `--fresh`）
3. session 仍在时，可补 `await app-ready` / `await stable`

```bash
miniprogram-browser open --session feat-a --project /path/to/miniprogram-root --fresh
sleep 8
miniprogram-browser open --session feat-a --project /path/to/miniprogram-root
miniprogram-browser await app-ready --session feat-a
miniprogram-browser await stable --session feat-a
```

如果开发者工具弹出「允许该项目 / 信任项目」：

- 这是开发者工具的项目安全确认，不是业务页弹窗
- 本 CLI 默认会尝试自动信任；若仍弹出，需要**人点一次确认**
- 确认后优先重跑同一个 `open`；session 还在时也可 `await app-ready` 或 `doctor`
- WSL 下优先把项目放在 `/mnt/<盘符>/...`；已有可用实例时，复用往往比反复 `--fresh` 更稳

本地已设置 `WECHAT_DEVTOOLS_CLI` 时不必重复 `export`。未全局安装时可先：

```bash
npx miniprogram-browser help
```

## 等待策略

优先级：

1. 业务命令直接挂 `--await`
2. 需要分步探测时用显式 `await <condition>`
3. `wait <ms>` 只做最后兜底

```bash
miniprogram-browser await app-ready --session feat-a
miniprogram-browser await stable --session feat-a
miniprogram-browser goto /pages/order/detail --session feat-a --await route:/pages/order/detail
miniprogram-browser click @e12 --session feat-a --await route-settled
miniprogram-browser screenshot --session feat-a --mode layout --await visible:.page-root
miniprogram-browser wait 1200 --session feat-a
```

建议：

- `open` 默认等待稳定（运行时响应、路径/页面栈短暂稳定等）
- `RUNTIME_UNSTABLE` 时不要先重启；优先 `await stable`，再用 `doctor` / `devtools logs`
- fresh 失败但人已看到页面：先短等，再**无** `--fresh` 重开
- 信任确认框：人确认后再 `open` / `await app-ready`
- 若日志里已出现 AppID 相关成功线索，但 automation 仍连不上，更可能是开发者工具自身服务/编译未就绪，而不是路径写错
- 不确定页面是否真显示时，可问人「已显示 / 仍白屏」，比盲目重复启动更稳
- `goto/click/native/screenshot/snapshot` 优先写 `--await`
- 不要把 `wait 3000` 当主路径

## 跨平台路径

目标：macOS / Windows / WSL 同一套用法。

- `--project` 始终写**当前 shell 可读**的小程序根目录
- macOS / Windows / WSL `/mnt/*` 由 CLI 自动转成开发者工具可接受的路径
- WSL **推荐**项目在 `/mnt/<盘符>/...`（例如 `/mnt/d/work/...`）
- Linux 家目录路径（如 `/home/...`）若开发者工具无法直接打开，用下面的高级兜底，或把项目放到盘符挂载路径
- 不要为了路径问题改用 GUI 截图、OCR、PowerShell 控窗

WSL 日常推荐：

```bash
miniprogram-browser open \
  --session feat-a \
  --project /mnt/d/work/demo/apps/miniprogram
```

### 高级路径兜底

自动转换不够用时：

```bash
miniprogram-browser open \
  --session feat-a \
  --project /home/wang/work/demo/apps/miniprogram \
  --devtools-project 'P:\work\demo\apps\miniprogram'
```

多个项目共享前缀时，可配置映射（分号分隔，最长前缀优先）：

```bash
export WECHAT_DEVTOOLS_PROJECT_MAP='/home/wang/work=P:\work;/home/wang/tmp=T:\tmp'
```

说明：

- `--devtools-project` / `--project-map` 只影响**交给开发者工具**的路径
- `--project` 仍用于本地发现项目、session 归属、截图等产物路径
- 不要在 WSL 里把 `P:\...` 直接当作 `--project`

## Session（工作台）

**session** 是你的操作上下文：当前项目、路由记忆、`@e` refs、日志等。  
同一项目可以有多个 session（并行任务）；日常一个就够。

### 怎么选名字

- **可省略 `--session`**：CLI 会按项目生成/复用类似 `myapp-x1` 的名字；`open --fresh` 且仍省略时，往往会再开一个新的自动名（如 `myapp-x2`）
- **显式命名**（推荐有语义）：`--session work`、`debug`、`feat-a`，便于并行与沟通
- 不要依赖无意义的全局固定名当「唯一默认台」去硬撞

### 项目从哪来

绑定后多数命令只需 `--session`（或继续省略以沿用自动 session）。项目作用域：

- 当前目录就是小程序根 → 直接用
- 同一 Git 工作树内可唯一发现 `apps/miniprogram` 或 `miniprogram` → 可用
- 不会跨出当前 Git 工作树去猜别的仓库

发现失败时，`open/connect` 请显式传 `--project`。

### 复用与新开

```bash
# 默认：尽量用上已有可用实例
miniprogram-browser open --session agent-task-a

# 明确要新开时
miniprogram-browser open --session agent-task-a --fresh
```

成功时输出里常见：

- `mode=attached` / `connected` / `started`：附着已有、连上、新启动等
- `attachedTo=...`：附着到谁（若有）
- `autoPort=...`：本次自动化连接端口（观测用；日常不必手填）
- `session=...`：实际使用的 session 名（省略时也能从这里确认）

端口相关：

- 常规**不必**传 `--auto-port` / `--devtools-port`
- `--auto-port` 仅在你要指定新开自动化端口时使用；附着已有实例时以实际连上的为准
- `--devtools-port` 仅在排查开发者工具 HTTP 服务时使用

### 并发与关闭

- 同一 session 内命令会串行；不同 session 可并行
- 多个 session 若连到同一小程序实例，工具会避免它们同时抢操作
- `close --session <name>`：默认结束该工作台；若只是附着别人的实例，通常**不会**关掉底层开发者工具窗口
- 需要关掉底层实例时，用 owner session 关闭，或按 CLI 帮助使用显式 runtime 关闭选项
- `session list`：默认当前项目；`session list --all` 看全部；输出含 `created`（创建时间）与 status/autoPort
- `session prune`：清理当前项目里过期/无效 session 记录，并尽量关掉对应工具窗口（不扫其他项目）
- `session kill <name>` / `session close <name>`：针对当前项目下的同名 session

### open 失败时怎么读

优先看返回里的说明和原始错误信息，判断是：

- 项目路径 / 映射问题
- 登录或 AppID 问题
- 开发者工具还在启动/编译
- 同项目已有多个实例需要你指定 session 或 `--fresh`

不要假设一定有固定错误码字段；以可读说明 + 原始日志为准。

## 诊断与逃逸

### 推荐诊断

- `app inspect`：应用结构摘要
- `doctor`：区分开发者工具、自动化连接、小程序 App 是否就绪
- `devtools logs`：开发者工具底层日志（App 不响应、普通 logs 不够时）
- `timeline`：路由变化
- `logs` / `exceptions`：console 与异常（优先用来理解数据加载、点击后发生了什么）
- `system-info` / `page-stack`：设备与页面栈

```bash
miniprogram-browser app inspect --session feat-a
miniprogram-browser doctor --session feat-a --json
miniprogram-browser logs --session feat-a --limit 20
miniprogram-browser exceptions --session feat-a
miniprogram-browser timeline --session feat-a
miniprogram-browser devtools logs --session feat-a --limit 40 --grep "appservice|simulator|error"
```

建议：

- 「页面没反应」不要只盯截图；先看 `logs` / `exceptions`
- Tool 层通但 App 不通时，优先 `devtools logs`，不要 GUI/OCR
- 判断某次 `open --fresh` 为何失败，以**同一次** open 返回的说明和日志为准
- 数据页/表单页 console 往往比截图更早暴露问题

### 底层与辅助命令

- `protocol <method> [json]`：自动化底层调用（如排查用）；**非**日常入口
- `eval` / `eval --stdin`：小程序运行时脚本（不是浏览器 DOM）
- `native <method> [...]`：开发者工具原生控制通道
- `call wx` / `call page`：调用 wx 或页面方法
- `get attr|prop|rect`：读属性/矩形
- `query <mode> <value>`：`selector | text | business` 快速定位，再切回 ref 命令
- `within <ref> <command> ...`：在某个 ref 作用域内执行子命令
- `relaunch <route>`：重启到指定路由（类似冷启动后的 goto）

原则：标准命令优先 → 不够再用逃逸 → 用完回到 ref/语义命令。

## Taro / H5 浏览器渲染（可选高保真视觉）

跨端 Taro 且 H5 可用时，浏览器渲染可作**辅助视觉**，不能替代小程序运行时证据：

- 浏览器：更高保真视觉截图
- `miniprogram-browser`：真实小程序结构、ref、logs、exceptions

适用：视觉留证、DevTools 真截图不稳但 H5 正常、核对样式细节。  
不适用：要证明小程序专属/原生能力、H5 未实现的 `wx` 行为、把浏览器图当成「小程序真截图」。

推荐步骤：

1. 小程序侧对齐尺寸：

```bash
miniprogram-browser system-info --session feat-a
```

关注 `windowWidth` / `windowHeight` / `pixelRatio`（设备像素比，用于对齐浏览器 DPR，不是让你改 snapshot 坐标）。

2. 浏览器 viewport 固定为相近尺寸，例如 `375×812` 或 `414×896`，DPR 2 或 3  
3. 浏览器只负责视觉图；结构/行为仍用 `logs`、`snapshot -i`、`screenshot --mode layout`  
4. 冲突时优先信小程序运行时证据  

结构分析优先 `screenshot --mode layout`，不要因为有浏览器就跳过小程序取证。

## app inspect

默认摘要，不直接倾倒整图。常见字段：`pagesSummary`、`tabBarSummary`、`current`、`pageStack`、`recentRoutes`、`currentOutgoingEdges`、`staticSummary`。

更细：

```bash
miniprogram-browser app inspect --sections a,b,c
miniprogram-browser app inspect --all
```

## screenshot

推荐顺序：

1. `snapshot -i`（非识图默认）
2. `screenshot --mode layout`
3. `snapshot -i --layout`
4. `--mode annotate`
5. `--mode page` / `--mode visual`

`layout` 更稳、更适合结构分析；真实像素适合留证或对视觉细节。

边界：

- `page/visual/annotate` 依赖开发者工具模拟器截图通道，≠ 真机画面
- 通道不稳时不要反复硬试；改 `layout` 或 `snapshot -i --layout`
- 不要默认用 `close/open` 或重启开发者工具修截图超时；多项目持续失败再考虑重启

模式：

- `--mode layout`：默认，结构布局图
- `--mode page`：官方页面截图
- `--mode visual`：页面截图 + 胶囊视觉合成
- `--mode annotate`：页面截图 + `@eN` 标注
- `--focus @e1,@e2`：高亮指定 ref
- `--no-ref`：隐藏图上 `@eN` 标签

路径：

- 不传路径：默认截图目录（仓库常见为 `artifacts/screenshots`）
- 传路径：保存到指定位置（建议可追溯目录，便于对照日志）

截图前：

1. `goto/click/fill/...` 后优先 `--await`
2. 先 `path` / `app inspect` / `snapshot -i` 确认页面稳定
3. 只看结构时直接 `layout`，不要死磕真实截图

`--focus`：先 `snapshot -i` 再 `screenshot --focus @e1,@e2`。`snapshot -i -c` 更紧凑，**不会**因 compact 单独重编号。

## 命令优先级（给 agent）

| 优先 | 用途 | 示例 |
|------|------|------|
| 主路径 | 日常操作 | `open` `snapshot` `click` `fill` `get` `goto` `await` `close` `session` `path` |
| 诊断 | 搞不清状态时 | `doctor` `logs` `exceptions` `timeline` `devtools logs` `app inspect` |
| 逃逸 | 标准命令不够时 | `protocol` `eval` `native` `call` `query` `within` 及高级截图 |

成功时优先看：`session`、`path`、`mode`、`project`，以及回显的连接端口信息。  
失败时：读清说明，并保留/查看原始错误；不要假设一定有固定 `code` 字段。

## `@e` 使用规则（必须遵守）

`@eN` 表示**当前 session 里、某次 snapshot 给出的可点击/可读取目标**。  
同页、结构变化不大时，再次 snapshot **有时**会沿用原来的编号，但：

- **不是**永远不变的全局 ID  
- **不是**跨 session 通用  
- **不是**「永远等于某个业务按钮」的保证  

必须遵守：

1. **先 `snapshot -i`（或本轮已产出 refs 的查询），只用本轮输出里的 `@eN`。**
2. **导航、列表刷新、弹层开关、明显重渲染后，必须重新 `snapshot -i`，不要拿旧号碰运气。**
3. **换页后旧 `@e` 全部作废**；提示 route 不一致时重新 snapshot。
4. **提示 stale / unknown ref / 找不到节点时，禁止重试同一个旧 `@e`**；重新 snapshot 再操作。
5. **换 session 必须重新 snapshot**；`@e` 不随 session 共享。
6. **ASCII 图上的数字 = `@eN` 的编号**（`23` → 命令写 `click @e23`）。读文案看语义树，不要从图里猜字。

补充：

- 需要跨会话稳定定位时，应在小程序侧使用 testid / 业务 key，再配合 `query`，而不是死记 `@e` 数字
- `snapshot -i -c` / `--layout` 不改变「先 snap 再用」的规则

## 常见误区

- 误以为 `open` 是打开网页 URL；它是绑定小程序工作会话
- 误以为 `open` 成功就等于已在目标页；应 `path` / `app inspect` / `snapshot` 确认
- 误以为总能猜中项目目录；发现失败时要显式 `--project`
- 误以为 WSL 里 `--project` 可以写 `P:\...`；应写 Linux 可读路径，必要时用 `--devtools-project` / `--project-map`
- 误以为登录过期仍能自动化；需在开发者工具重新登录
- 误以为必须每次手写端口；日常不用管，成功输出里的端口仅供确认与排障
- 误以为 `@eN` 永久有效或跨页/跨 session 仍可用
- 误以为 ASCII 图上的 `3` 表示「第三项」而不是 `@e3`
- 误以为 `snapshot -i` 需要业务自备 tree
- 误以为 `timeline` 是截图历史；它是路由事件
- 误以为 `eval` 是浏览器 DOM 脚本
- 误以为 `native` 等于普通 `click`
- 误以为多 session 一定等于多个完全隔离的工具窗口；并行时仍可能共享同一运行中的小程序实例
- 误以为可以无等待狂点；优先 `--await`
- 误以为应直接调用包装库内部模块；请通过 CLI 使用
