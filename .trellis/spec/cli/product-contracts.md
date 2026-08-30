# CLI 产品契约（Beta 冻结）

> 适用范围：对外 **CLI 稳定面**、**`@e` 生命周期**、成功/失败输出最低约定。  
> 权威读者：agent skill、维护者。实现细节见 `session-contracts.md` / `ascii-map-contracts.md`。  
> 变更：修改 L0 命令语义、`@e` 分配/失效规则或公共输出字段时，必须同步本文件与 `skills/miniprogram-browser/SKILL.md`。

## 1. Scope / Trigger

- 触发：beta 产品边界需要「说清楚、可验收」，避免把内部模块或 `@e` 编号当成永久 API。
- 公共产品 = **命令行 CLI**（`miniprogram-browser` / `npx miniprogram-browser`），不是 HTTP API，也不是稳定 Node SDK。

## 2. Signatures（公共面）

### 2.1 稳定 CLI 分层

| 层 | 稳定性 | 命令 |
|----|--------|------|
| **L0 主路径** | 稳定；破坏性变更需重大版本+文档 | `open` / `connect`，`goto` / `relaunch`，`snapshot`，`click` / `tap`，`back`，`scroll`，`swipe`，`longpress`，`fill` / `input`，`get`，`await`，`close`，`session list\|prune\|kill`，`path`，`help` |
| **L1 诊断** | 稳定意图；字段可扩展 | `doctor`，`logs`，`exceptions`，`timeline`，`devtools logs`，`app inspect`，`page-stack`，`system-info` |
| **L2 逃逸** | 尽力而为；可改可删 | `protocol`，`eval`，`native`，`call`，`query`，`within`，`wait`，`screenshot` 高级模式 |

### 2.2 全局选项（稳定）

- `--session <name>`：显式工作台；省略时优先沿用项目活动 session，其次按项目自动 `{slug}-xN`（见 session-contracts）。同项目存在多个不同 live runtime 且没有活动/显式命中目标时，必须显式指定 session
- `--project <path>`：可省略（cwd/Git 唯一发现）
- `--json`：机器可读
- `--fresh`：强制新 runtime（open）
- `--await` / `--no-await` / `--timeout` / `--wait` / `--follow`

### 2.3 非公共面

```text
dist/lib/**、src/lib/** 的 require API
  → 实现细节，默认无 semver 承诺
  → 嵌入方若依赖，需自行锁定版本并接受破坏
```

## 3. Contracts

### 3.1 成功路径（产品）

```text
open [ --project ] [ --session ]
  → 脏活内收：trust / 路径 / 端口 / runtime 复用
  → `--timeout` 是本次 open 的总预算；live probe、DevTools CLI、等待与连接共享剩余时间
  → 成功须可观测（文本或 JSON）：
      session, path（或 appReady/warming 语义）, mode, autoPort, project
  → 其余（strategy、devtoolsProject…）可出现，非硬依赖字段
```

日常 action 不默认插入固定 sleep；已知结果使用 `route:` / `visible:` / `hidden:` 等精确 `--await`，未知同页结果使用 action 专属的 `--await change`。`change` 在动作前采集 route、页面栈和编译后 WXML 签名，动作后返回第一次可观察变化；它不依赖原生/Taro/uni-app 生命周期，也不等同于长期保存瞬时证据。独立 `await change` 因没有动作前基线必须报错。`stable` 只承诺路径/页面栈短暂稳定；渲染树能力以 `viewReady` / `viewError` 单独观测，不承诺业务数据完成。

`goto` 必须直接发起底层路由动作，再按目标路由轮询确认，不得退回 `miniprogram-automator` 内置的固定 3 秒 route sleep。`back` 优先调用 DevTools 原生返回并验证 route；原生返回假成功时，使用无固定 3 秒等待的小程序页面栈回退。`swipe` 对普通元素优先发送 touch 序列；原生 `swiper` 在 DevTools 不执行组件默认行为时，回退到 automator 提供的 `swipeTo` 组件动作，仍不得用 `eval/setData` 改写业务状态。该边界与 [uni-app 自动化 API 对 `swipeTo` 的组件限定](https://uniapp.dcloud.net.cn/worktile/auto/api.html#element-swipeto) 一致。automation 启用后默认立即探测 live 端口，未就绪才在总 deadline 内轮询；`doctor --wait` 只限制状态轮询窗口，`--wait 0` 表示单次探测。这一取舍参考 agent-browser 的 [核心 snapshot/action 循环](https://github.com/vercel-labs/agent-browser/blob/main/skill-data/core/SKILL.md) 与 [条件等待命令](https://github.com/vercel-labs/agent-browser/blob/main/skill-data/core/references/commands.md)，但保留微信开发者工具冷启动所需的独立长预算。

Windows/WSL 对 DevTools 可直接消费的盘符路径，冷启动默认使用 `open → auto`；`open` 解析出的 IDE service port 只用于观测和 cleanup，后续 `auto` 不强塞 `--port`。WSL 路径转换以系统 [`wslpath`](https://learn.microsoft.com/en-us/windows/dev-environment/wsl-interop#path-translation) 为权威，支持自定义 automount root；UNC 无法被当前 DevTools 消费时才使用显式项目路径或 prefix map。

### 3.2 失败路径（产品）

```text
人话说明情况
+ 保留底层 DevTools/CLI/automator 原文（raw / 二次输出）
不强制稳定 code / next action
禁止用本项目空泛包装盖掉根因
```

**失败输出形态（可执行）：**

| 通道 | raw 行为 |
|------|----------|
| 文本 stderr | 人话 +（可选）hint + **raw 摘录**（`summarizeDevtoolsCliRaw`，保留 `[error]`/41002/INVALID_LOGIN/`Using AppID`/`start cli server error` 等真因行；避免 `--debug` 全文淹没） |
| JSON `--json` | `error.raw` **保留完整**原文；`error.message` 为人话 |

**AppID / auto 分类（禁止假阳性）：**

- DevTools 成功 `auto` 也会打印 `Fetching AppID () permissions`，随后才有 `Using AppID: wx…` / `✔ auto`。
- **禁止**仅凭 `Fetching AppID () permissions` 判定 AppID 缺失。
- 真失败须有明确信号：`errcode=41002` / `appid missing` 等，且无成功 `Using AppID`。
- 实现：`hasAutomationCliSuccessSignal` / `explainDevtoolsFailureRaw` / `parseAutomationCliFailure`（`runtime-cli-shared.ts`）。
- automation WebSocket 和 `App.*` 成功、但 `Page.getElements` / `Element.getWXML` 超时，必须在有限时间内返回 `DEVTOOLS_RENDER_AUTOMATION_UNAVAILABLE` 并保留原始协议超时；不得返回空 snapshot 或要求改用生产 AppID。

### 3.3 `@e` 生命周期（硬契约）

```text
@eN = 当前 session 最新一次完整 snapshot 世代内的可解析句柄
    每次完整 snapshot 从 @e1 按规范语义树顺序重建，并替换上一世代
    ≠ 全局永久 ID / 跨 session ID / 跨路由永久指针
```

- 页面语义树和顺序不变时，确定性遍历会自然得到相同编号；这不是跨结构变化的持久 ID 承诺。
- `stableKey` 只用于本轮 snapshot 到动作执行之间重新读取当前树并确认目标身份，不用于跨 snapshot 累积编号。

**使用协议（agent 必须遵守）：**

1. **先 `snapshot`（或等价产生 refs 的查询）再使用本轮输出中的 `@eN`。**
2. **页面结构可能变化后（点击后导航、列表刷新、弹层开关等）必须重新 `snapshot`，不得沿用旧号碰运气。**
3. **路由变化后，旧页 `@e` 全部作废**（实现会 `Ref route mismatch`）。
4. **收到 stale / unknown ref / selector 失效时：禁止重试同一旧 `@e`；重新 snapshot 再操作。**
5. `--follow` 仅在显式请求时于 action 后生成一次新的 refs 摘要；默认操作输出保持低噪声。
6. 普通按钮、表单控件点击后停留当前路由是正常成功；CLI 不得猜测“本应跳转”并输出登录/授权弹窗提示。确需验证导航时显式使用 `--await route-change` / `route:<path>`。
7. **`@e` 仅在产生它的 session 内有效**；换 session 必须重新 snapshot。
8. 默认 ASCII 图中的数字 = `@eN` 的编号 N；命令里仍写完整 `@eN`。文案以语义树为准，不以图内文字为准（图不渲染文案）。
9. 同页存在多个 selector、文案都相同的控件时，每个 ref 必须解析到 snapshot 对应的 occurrence；带 id/data-sid 的同标签兄弟不得挤占通用 selector 的索引。
10. 标准 checkbox/radio 的直接 element tap 若不会触发 group change，`click` 必须优先点击包含它的最小 label；不得只因底层 tap 返回成功就宣称状态已变化。

### 3.4 Snapshot 双通道

```text
snapshot = 紧凑语义树（类型、文案、@eN、层级）+ 紧凑 ASCII 空间图
--layout = 在语义树中额外追加精确比例 rect
--no-map = 关闭默认 ASCII 图；不带 --layout 时也避免 rect 查询
--json = route + count + records（不重复 lines / record.route）
--all = 完整树与内部细节
```

`-i` 与 `-c` 只作为旧调用兼容入口保留；默认调用不需要参数，且默认已经 compact。

### 3.5 框架中立的公开 Demo

```text
微信原生 / Taro / uni-app
  → 上游各自生成标准微信小程序文件
  → 工程根 project.config.json 的 miniprogramRoot 指向原生产物
  → open / inspect / snapshot / click / fill / back / scroll / swipe / longpress / goto / screenshot / close 使用同一契约
```

- CLI 不检测 Taro/uni-app，也不增加框架专用参数或行为分支。
- 公开测试与真实 DevTools gate 只允许仓库内 `touristappid`、合成数据的 Demo；生产项目、真实截图、账号和业务数据不得进入开源产物。
- 框架源码变化后必须先重新构建，再对工程根执行 `open`；构建属于框架职责，不由 CLI 隐式执行。

### 3.6 Session

```text
显式 --session <name> 一等公民（并行工作台）
省略 → 项目语义名 {slug}-xN 生成/复用
多个不同 live runtime 且无显式目标 → 返回候选 session，不按 `updatedAt` 选择“最新”
禁止把 default 当产品默认名
autoPort 不落 session 文件；成功可回显
```

## 4. Validation & Error Matrix

| 条件 | 结果 |
|------|------|
| 使用未知 `@e` | 错误；应重新 snapshot |
| `@e` 路由与当前页不符 | `Ref route mismatch`；重新 snapshot |
| stableKey/signature 对不上 | stale；重新 snapshot |
| 多个同文案、同 selector 控件 | 按当前结构 occurrence 精确解析；不得退回第一个同文案元素 |
| 依赖 `dist/lib` 私有导出 | 不在兼容承诺内 |
| 登录失效等 | 人话 + raw；工具不伪造成功 |
| 成功 auto 日志含 `Fetching AppID () permissions` | **不得**判 AppID 失败；`parseAutomationCliFailure` → null |
| 真 41002 / appid missing（无 Using AppID 成功） | 人话 AppID 问题 + 保留 raw 真因 |
| `App.*` 可用但 `Page.*` / `Element.*` 超时 | `DEVTOOLS_RENDER_AUTOMATION_UNAVAILABLE` + 原始方法/timeout；不伪造空 snapshot |
| 非 open 命令且 automation 非 live | 明确要求先 `open`；**禁止**默认再跑全量 `devtools auto --debug` |
| 无法发现 project / session | 人话 + 可执行下一步（进入小程序目录或 `--project` / `--session`） |
| `doctor` 仅连上 Tool endpoint、但 App runtime 未就绪 | `ok: false`，保留 `probe.connected: true` / `probe.appReady: false` 并给出下一步 |
| 显式截图路径位于小程序项目内 | 截图仍执行，但返回可能触发重新编译/状态重置的 notice；默认路径仍放系统临时目录 |
| 独立执行 `await change` | `CLI_USAGE_ERROR`；改为在 action 上使用 `--await change` |
| `back` 当前页面栈只有一页 | 明确失败；需要特定页面时使用 `goto` |

## 5. Good / Base / Bad

- **Good**：`open` → `snapshot` → `click @e3`（`@e3` 来自本轮输出）
- **Good**：未知同页结果用 `click @e3 --await change --follow`；已知结果仍优先精确 selector/route
- **Good**：click 导致跳转后先 `snapshot` 再点新 `@e`
- **Good**：open 失败文本首屏可读（人话 + 短 raw 摘录）；JSON 仍有完整 `error.raw`
- **Base**：同一语义树与顺序重复 snapshot，确定性生成相同 `@eN`
- **Bad**：隔天仍用昨天的 `@e7`；跨 session 复用 `@e`；把图上的 `3` 当成「第三项」而非 `@e3`
- **Bad**：把 `require('…/dist/lib/session-store')` 当公共 API
- **Bad**：把成功 auto 的 `Fetching AppID () permissions` 解释成 AppID 缺失
- **Bad**：未 open 时对 `snapshot` 无脑 `enableAutomation` 刷 debug 全文

## 6. Tests Required

- 文档任务：无强制新单测
- `tests/runtime.test.cjs`：完整 snapshot 跨页后重新从 `@e1` 编号；回到未变页面时编号一致；compact/full 复用同一规范编号。
- `tests/help.test.cjs`：默认 ASCII policy 与紧凑 JSON 字段。
- 冷启动/失败分类：`tests/runtime.test.cjs`
  - 成功 raw（Fetching + Using AppID + ✔ auto）→ `parseAutomationCliFailure` null
  - 真 41002 → 仍人话 AppID + raw
  - `summarizeDevtoolsCliRaw` 保留 error 行且有行数上界
  - `connectOrEnable({ allowEnable: false })` 非 live → 提示先 open
- 若未来对输出字段做代码 enforcement，另开任务
- 三框架公开 Demo：`tests/public-demo.test.cjs` 与 `tests/framework-demos.test.cjs` 固化共同路由、控件、重复列表、导航及合成数据边界；Taro/uni-app 另做显式构建和真实 DevTools gate
- 真实交互与变化等待：`tests/runtime-actions.test.cjs` 覆盖优先 touch 的 swipe、原生 swiper 组件回退、页面/容器滚动、back 回退与 WXML change；真实 DevTools gate 验证公开 Demo 的实际状态变化

## 7. Wrong vs Correct

#### Wrong
```text
click @e1   # 未 snapshot，或沿用上一页/上一 session 的号
# 假设 @e1 永远是「保存按钮」
```

#### Correct
```text
snapshot
click @e12  # 号来自本轮树
# 导航后
snapshot
click @e4
```

#### Wrong
```ts
const { allocateRef } = require('miniprogram-browser/dist/lib/core.js') // 当 SDK
```

#### Correct
```bash
npx miniprogram-browser snapshot --json
npx miniprogram-browser click @e3
```

## 交付缺口（非本契约执行项）

- 将 main / `feat/ascii-map-wireframe-v1` 推送到有权限的 remote 并开 PR
- 真机门禁：`open` → `snapshot` → `click` → `goto` 可重复
