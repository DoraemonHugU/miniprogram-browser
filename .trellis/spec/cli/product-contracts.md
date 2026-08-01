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
| **L0 主路径** | 稳定；破坏性变更需重大版本+文档 | `open` / `connect`，`goto` / `relaunch`，`snapshot`，`click` / `tap`，`fill` / `input`，`get`，`await`，`close`，`session list\|prune\|kill`，`path`，`help` |
| **L1 诊断** | 稳定意图；字段可扩展 | `doctor`，`logs`，`exceptions`，`timeline`，`devtools logs`，`app inspect`，`page-stack`，`system-info` |
| **L2 逃逸** | 尽力而为；可改可删 | `protocol`，`eval`，`native`，`call`，`query`，`within`，`wait`，`screenshot` 高级模式 |

### 2.2 全局选项（稳定）

- `--session <name>`：显式工作台；省略时按项目自动 `{slug}-xN`（见 session-contracts）。同项目存在多个不同 live runtime 且没有命中目标时，必须显式指定 session
- `--project <path>`：可省略（cwd/Git 唯一发现）
- `--json`：机器可读
- `--fresh`：强制新 runtime（open）
- `--await` / `--no-await` / `--timeout` / `--wait`

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
  → 成功须可观测（文本或 JSON）：
      session, path（或 appReady/warming 语义）, mode, autoPort, project
  → 其余（strategy、devtoolsProject…）可出现，非硬依赖字段
```

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

### 3.3 `@e` 生命周期（硬契约）

```text
@eN = 当前 session 内、以 snapshot 为界的可解析句柄
    尽力通过 stableKey 跨 snapshot 复用同号
    ≠ 全局永久 ID / 跨 session ID / 跨路由永久指针
```

**使用协议（agent 必须遵守）：**

1. **先 `snapshot -i`（或等价产生 refs 的查询）再使用本轮输出中的 `@eN`。**
2. **页面结构可能变化后（点击后导航、列表刷新、弹层开关等）必须重新 `snapshot -i`，不得沿用旧号碰运气。**
3. **路由变化后，旧页 `@e` 全部作废**（实现会 `Ref route mismatch`）。
4. **收到 stale / unknown ref / selector 失效时：禁止重试同一旧 `@e`；重新 snapshot 再操作。**
5. **`@e` 仅在产生它的 session 内有效**；换 session 必须重新 snapshot。
6. **ASCII 图中的数字 = `@eN` 的编号 N**；命令里仍写完整 `@eN`。文案以语义树为准，不以图内文字为准（图默认不渲染文案）。

### 3.4 Snapshot 双通道

```text
语义树 = 主（类型、文案、@eN、层级）
ASCII  = 辅（区域框 + 编号锚点；LOD + 避让）
--no-map 可关图
```

### 3.5 Session

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
| 依赖 `dist/lib` 私有导出 | 不在兼容承诺内 |
| 登录失效等 | 人话 + raw；工具不伪造成功 |
| 成功 auto 日志含 `Fetching AppID () permissions` | **不得**判 AppID 失败；`parseAutomationCliFailure` → null |
| 真 41002 / appid missing（无 Using AppID 成功） | 人话 AppID 问题 + 保留 raw 真因 |
| 非 open 命令且 automation 非 live | 明确要求先 `open`；**禁止**默认再跑全量 `devtools auto --debug` |
| 无法发现 project / session | 人话 + 可执行下一步（进入小程序目录或 `--project` / `--session`） |

## 5. Good / Base / Bad

- **Good**：`open` → `snapshot -i` → `click @e3`（`@e3` 来自本轮输出）
- **Good**：click 导致跳转后先 `snapshot -i` 再点新 `@e`
- **Good**：open 失败文本首屏可读（人话 + 短 raw 摘录）；JSON 仍有完整 `error.raw`
- **Base**：同页二次 snapshot，带 stableKey 的节点尽量仍是原 `@eN`
- **Bad**：隔天仍用昨天的 `@e7`；跨 session 复用 `@e`；把图上的 `3` 当成「第三项」而非 `@e3`
- **Bad**：把 `require('…/dist/lib/session-store')` 当公共 API
- **Bad**：把成功 auto 的 `Fetching AppID () permissions` 解释成 AppID 缺失
- **Bad**：未 open 时对 `snapshot` 无脑 `enableAutomation` 刷 debug 全文

## 6. Tests Required

- 文档任务：无强制新单测
- 回归依赖已有：`tests/core.test.cjs` ref 复用；resolve stale 文案在 runtime 路径
- 冷启动/失败分类：`tests/runtime.test.cjs`
  - 成功 raw（Fetching + Using AppID + ✔ auto）→ `parseAutomationCliFailure` null
  - 真 41002 → 仍人话 AppID + raw
  - `summarizeDevtoolsCliRaw` 保留 error 行且有行数上界
  - `connectOrEnable({ allowEnable: false })` 非 live → 提示先 open
- 若未来对输出字段做代码 enforcement，另开任务

## 7. Wrong vs Correct

#### Wrong
```text
click @e1   # 未 snapshot，或沿用上一页/上一 session 的号
# 假设 @e1 永远是「保存按钮」
```

#### Correct
```text
snapshot -i
click @e12  # 号来自本轮树
# 导航后
snapshot -i
click @e4
```

#### Wrong
```ts
const { allocateRef } = require('miniprogram-browser/dist/lib/core.js') // 当 SDK
```

#### Correct
```bash
npx miniprogram-browser snapshot -i --json
npx miniprogram-browser click @e3
```

## 交付缺口（非本契约执行项）

- 将 main / `feat/ascii-map-wireframe-v1` 推送到有权限的 remote 并开 PR
- 真机门禁：`open` → `snapshot -i` → `click` → `goto` 可重复
