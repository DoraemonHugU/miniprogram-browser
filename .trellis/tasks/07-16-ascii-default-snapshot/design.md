# 设计：snapshot 默认 ASCII 空间图 + 通道/flag 修复

## 设计原则（用户定稿）

- **模型分派**：非识图模型 → `snapshot`（默认 ASCII 空间图）；识图模型 → `screenshot --mode page|visual|annotate`（真实图片）。SKILL.md 显式写明。
- **方案 C（混合）**：文本树（结构 + ref + 文本标签） + 紧凑 ASCII mini-map（空间方位），两者用同一 `@eN` ref 交叉引用。
- **CLI 做重活**：默认通道安全、关键命令默认等待、`snapshot` 不藏真实像素；调用方只做「最后一步」。

## 1. ASCII 空间 mini-map 渲染器（新文件 `src/lib/ascii-map.ts`）

纯函数，输入 `records`（已含 `rectPct` 的 ref 列表），输出字符串图块。**不依赖任何图像库、不碰 `miniProgram.screenshot`**。

### 参数表（效果验证门）

| 参数 | 公式 / 值 | 说明 |
|------|------------|------|
| `GRID_W` | `48` | 固定列数（等宽字符宽度） |
| `GRID_H` | `clamp(round(GRID_W × (vpH/vpW) × 0.5), 16, 56)` | 乘 `0.5` 补偿等宽字符约 2:1 高宽比；竖屏（vpH>vpW）得更高网格，上下封顶保可读性 |
| 坐标 | `col = floor(x/100 × GRID_W)`，`row = floor(y/100 × GRID_H)` | `rectPct` 已是 0–100 百分比 |
| 跨度 | 宽 `floor(w/100 × GRID_W)`，高 `floor(h/100 × GRID_H)` 行 | 元素范围 |
| ref 标记 | 只画 `@eN` 的数字部分（1–99）；>99 折叠为 `a1`/`b1`；每格至多 2 字符 | 避免格子被冲掉 |
| 行标注 | 每行左侧写其 y% 区段（如 ` 50%│`） | 让模型知道「第 N 行 ≈ 页面 N% 处」 |
| 图例 | 图上方一行 `top-left=(0,0) x→右 y→下; 每行≈{100/GRID_H}%` | 方位说明 |

### 分层渲染（解决重叠的核心）

1. **第一遍**：画**容器/分区**的 ASCII 边框盒（`+---+` / `|`），用缩写标识类型（`btn`/`txt`/`inp`/`img`/`list`/`view`/`nav`/`tab`）。
2. **第二遍**：把**叶子交互元素**（按钮、文本、输入）的 ref 数字叠在它的中心格。
3. **冲突规则**：同一格被多个元素占用 → 交互叶子优先；仍冲突 → 打 `*` 碰撞标记。

### 导出

```ts
function renderAsciiMap(records, options: { gridW?: number; viewport?: {w:number;h:number} } = {}): string
// 返回空串或图例+网格；无 rectPct 的 record 被跳过。
module.exports = { renderAsciiMap }
```

### 单测（tests/ascii-map.test.cjs，纯文本断言，无需 DevTools）

- 给定两条 `rectPct`，断言输出含两个 ref 数字、且行标注出现。
- 重叠叶子：两条 rect 中心同格 → 断言出现 `*`。
- 空 records → 返回空串（不报错）。
- `viewport` 竖屏（375×812）→ `GRID_H` 在合理范围（16–56），图不爆炸。

## 2. `snapshot` 默认加 ASCII 图 + 移除隐藏像素 probe

### 2.1 渲染接线（`handleSnapshot`，miniprogram-browser.ts:1776）

- 现状：`--layout` 才 `collectRecordRects` + `mergeRecordLayouts` + `formatSnapshotLines({layout:true})`。
- 改为：当 `options.layout` **或** `!options.noMap`（默认 `noMap=false`）时，收集 `rectPct` 并合并；文本树照旧输出，`lines` 末尾追加 `renderAsciiMap(records)` 块。
- 新增 boolean flag：`--no-map`（关闭图），写入 `cli-io.ts` 的 `booleanFlags`，且 `--map` 可显式开启（与 `no-map` 互斥，默认开）。
- `snapshot -i --layout` 的 rect 数字继续保留（精确比值场景）。

### 2.2 移除隐藏 probe（miniprogram-browser.ts:1800）

- 现状：`shouldAttemptVisualProbe(state, page.path, scopeRef)` 在「无 lastVisualProbe / 路由变化 / 有 pendingVisualAction」时**无条件**触发 2500ms 真实像素（`captureVisualProbeForSnapshot` → `createVisualProbe` → `captureScreenshotToPath(...,2500)`）。
- 改为：仅当显式 `--visual`（或未来真实像素入口）为真时才触发；默认 `snapshot` 不再付这笔不稳定开销。
- `shouldAttemptVisualProbe` 签名加 `options`，内部读 `options.visual`；`tests/help.test.cjs:566-570` 的四个断言须相应更新（route 变化但无 `--visual` → `false`）。
- `summarizeSnapshotPayload`（cli-payload.ts:31）可附 `map` 字段（ASCII 图串）到非 json 输出路径；JSON 模式把图放进 `summary.map`。

## 3. `screenshot` 默认模式对齐稳定优先

### 现状

- `handleScreenshot`（miniprogram-browser.ts:2264）：`const mode = options.mode || 'page'` → 默认走不稳定的 `miniProgram.screenshot` 通道。

### 改动

- 默认 `mode` 改为稳定优先：未传 `--mode` 时落到 `layout`（纯 JS/Jimp/canvas，不走官方截图）；或改为「默认不截真实像素，显式才截」。
- 用户原话：「可以通过组合拿到两个，或者一个命令只拿一个，都取决于默认参数」。落地为：`screenshot` 默认 `layout`（安全、给结构）；要真实像素显式 `--mode page|visual|annotate`。
- `cli-help.ts:62` 的 `默认 page` → `默认 layout`；`tests/help.test.cjs` 相关断言同步。
- `tests/build.test.cjs` / `skill-docs.test.cjs` 若引用 `page` 默认须检查并更新。

## 4. 清理 `--trust-project` 陷阱 + SKILL.md 模型分派

### 4.1 flag（cli-io.ts:92、runtime.ts:1183）

- 现状：`--no-trust-project` 设 `trustProject=false`；正向 `--trust-project` 无分支 → `readOptionValue` 抛 `CLI_USAGE_ERROR`（`tests/skill-docs.test.cjs:34` 把 `--trust-project` 列入 `KNOWN_HIDDEN_FLAGS` 掩盖此坑）。
- 改为：新增 `--trust-project` → `trustProject=true`；`--no-trust-project` → `false`。二者都合法，默认由 `WECHAT_DEVTOOLS_TRUST_PROJECT` env / 自动信任决定。
- 把 `--trust-project` 从 `KNOWN_HIDDEN_FLAGS` 移除（skill-docs 守卫现在会真正校验它）。
- `tests/help.test.cjs:160`（parseArgs 验证 `--no-trust-project`）保留；新增一条验证 `--trust-project` 设 `true` 不报错。
- `tests/runtime.test.cjs:1348`（buildAutomationArgs 含 `--trust-project`）保持。

### 4.2 SKILL.md 模型分派约定（新增小节）

显式写明：

> **模型分派**：非识图模型用 `snapshot -i`（默认 ASCII 空间图）；识图模型用 `screenshot --mode page|visual|annotate`（真实图片）。不要对非识图模型默认推真实截图。

同时更新「最常用流程」「screenshot」小节里的默认模式描述，与 §3 一致。

## 5. 受影响的测试 / 文档清单

| 文件 | 改动 |
|------|------|
| `tests/help.test.cjs:566-570` | `shouldAttemptVisualProbe` 加 `options`，断言更新 |
| `tests/help.test.cjs:160` | 保留 `--no-trust-project`；新增 `--trust-project` 设 `true` 不报错 |
| `tests/skill-docs.test.cjs:34` | `KNOWN_HIDDEN_FLAGS` 移除 `--trust-project` |
| `tests/help.test.cjs` screenshot 段 | `默认 page` → `默认 layout` |
| `tests/ascii-map.test.cjs` | 新增：渲染器纯文本断言 |
| `src/lib/cli-help.ts` | snapshot 加 `--no-map`/`--map`；screenshot 默认说明 |
| `SKILL.md` | 模型分派小节 + 默认模式描述 |
| `.trellis/spec/cli/screenshot-contracts.md` | R1/R2 提为确立契约（含 ASCII 参数表 + 默认通道值） |

## 6. 兼容性 / 风险

- ASCII 渲染纯文本、零新增依赖（不引入 fontkit/Jimp 之外的东西；实际只用 `String` 拼接）。
- `rectPct` 已稳定存在，无官方截图依赖 → 渲染器本身不会触发不稳定通道。
- 默认行为变化（snapshot 加图、screenshot 默认 layout、snapshot 不藏 probe）会影响既有调用方：SKILL.md + help 文本同步更新，避免文档/实现脱钩（skill-docs 守卫会拦）。
