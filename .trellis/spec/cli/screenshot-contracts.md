# CLI 截图 / 视觉契约（code-spec）

> 适用范围：`miniprogram-browser screenshot`、`snapshot` 的视觉与结构输出通道。
> 维护者：改动 `src/miniprogram-browser.ts` 的 `handleScreenshot` / `handleSnapshot`、`src/lib/visual.ts`、`src/lib/runtime.ts` 的 `captureScreenshotToPath` 时，必须同步本文件。

## 1. Scope / Trigger

- 触发：截图模式（page/visual/annotate/layout）属于跨层契约（CLI flag → runtime 通道 → 产物）。
- 背景（已确立事实）：官方模拟器截图通道（`miniProgram.screenshot`）在 WSL / 长链路下偶发超时，README 与 SKILL.md 均已承认。
- 本契约记录「哪条通道稳定、哪条不稳定、默认值是什么、snapshot 的隐蔽副作用」。

## 2. Signatures

```ts
// src/miniprogram-browser.ts
async function handleScreenshot(state, outputPath, options)
async function handleSnapshot(state, options, scopeRef = null)

// src/lib/runtime.ts —— 不稳定通道
async function captureScreenshotToPath(miniProgram, targetPath, timeoutMs = 15000)
  // 内部: await miniProgram.screenshot({ path: targetPath })

// src/lib/visual.ts —— 稳定通道（纯 JS，不调官方截图）
async function captureLayoutScreenshot({ targetPath, config, refs, ... })
async function captureVisualScreenshot({ miniProgram, targetPath, config, timeoutMs, pageCapture })
```

## 3. Contracts

### 3.1 截图模式 → 通道映射（关键）

| `--mode` | 产物 | 底层通道 | 稳定性 |
|----------|------|----------|--------|
| `page`   | 官方页面截图 PNG | `captureScreenshotToPath` → `miniProgram.screenshot` | **不稳定** |
| `visual` | 页面截图 + 胶囊视觉合成 | `captureVisualScreenshot` → `pageCapture` → `captureScreenshotToPath` | **不稳定** |
| `annotate` | 页面截图 + `@eNN` 标注叠加 | `captureScreenshotToPath` + 叠加 | **不稳定** |
| `layout` | 语义布局图 PNG | `captureLayoutScreenshot`（Jimp + canvas 字体） | **稳定，不调官方截图** |

- **默认模式**：`options.mode || 'layout'`（`src/miniprogram-browser.ts` 的 `handleScreenshot`）→ **默认即稳定通道**。未知 `--mode` 不再静默降级到 `page`，而是走到默认 `layout`。
- `layout` 用 `collectRecordRects`（基于 `page.$$` 选择器 + 元素尺寸，**非像素**）重建结构，再纯 JS 绘制（`src/lib/visual-change.ts:111`、`src/lib/visual.ts:677`）。

### 3.2 文本结构输出（非视觉，供非识图模型）

- `snapshot -i` → `formatSnapshotLines`（`src/lib/core.ts:268`）：按 DOM 嵌套深度缩进的树（结构化 ref 文本树）。
- `snapshot -i --layout` → 每个 ref 追加比例 rect：`@e20 [button] 工具箱 {x:10.4,y:82.1,w:24.5,h:6.8}`。
- **默认 ASCII 空间图**：`snapshot`（`-i` 或普通）默认附带紧凑 ASCII mini-map（`renderAsciiMap`，`src/lib/ascii-map.ts`），由同一套 `rectPct` 比例坐标（`collectRecordRects`，**非像素**）渲染，用 `@eN` 与文本树交叉引用，表达左右并排 / 上下堆叠等空间方位。
  - 参数（`src/lib/ascii-map.ts`，已定稿，勿随意改动）：
    - `GRID_W = 48`（固定列宽）
    - 行高 `GRID_H = clamp(round(GRID_W × (viewportH / viewportW) × 0.5), 16, 56)`（竖屏更高，范围 16–56）
    - 每行左侧标该 y% 区段；`@eN` 数字标记元素中心；容器画边框盒（`+ - |`）；`*` 标记碰撞
    - ref 数字折叠：`>99` → `aN`/`bN` 段
  - `--no-map` 关闭该默认 ASCII 图；`--layout` 仅影响文本树里的精确比例 rect，不影响 ASCII 图。

### 3.3 snapshot 的真实像素副作用（已收敛为显式 opt-in）

- `handleSnapshot` 仅在 `options.visual === true` 且 `scopeRef` 为空且（无 `lastVisualProbe` 或 route 变化或存在 `pendingVisualAction`）时，才触发 `captureVisualProbeForSnapshot`。
- 该 probe 走 `captureScreenshotToPath(..., 2500)`（真实像素，2500ms，`src/miniprogram-browser.ts`）。
- **含义**：`snapshot` 默认（不带 `--visual`）是**零真实像素**的纯文本 + ASCII 输出；真实像素探针升级为显式 `--visual` 触发，不再是隐蔽默认行为。

## 4. Validation & Error Matrix

| 条件 | 结果 |
|------|------|
| `--mode` 为未知值 | `handleScreenshot` 落到默认 `layout`（稳定通道，不静默降级到不稳定 `page`） |
| `--focus` 引用不存在的 ref | `resolveFocusTargets` 抛 `Unknown focus refs: ...`（`src/lib/visual.ts:757`） |
| 官方截图超时 | `captureScreenshotToPath` 抛超时错误（page/visual/annotate 失败；layout 不受影响） |
| `--trust-project` 传入 | `parseArgs` 正向分支置 `options.trustProject = true`（`src/lib/cli-io.ts`）；反向 `--no-trust-project` 置 `false`。二者均为可选 escape hatch，默认信任。 |

## 5. Good / Base / Bad Cases

- **Good**：需要稳定结构理解 → `screenshot`（默认 `layout`，无需写 `--mode`）；非识图模型 → `snapshot -i`（默认 ASCII 空间图）。
- **Base**：未指定模式 → 默认 `layout`，走稳定通道（当前默认行为）。
- **Bad**：在非视觉、非识图场景下依赖 `page`/`visual`/`annotate` 不稳定截图；或在 `snapshot` 后假设会附带真实像素成本（默认 `--no-map` 关闭、真实像素需 `--visual`）。

## 6. Tests Required

- `tests/skill-docs.test.cjs` 已守卫「SKILL.md 引用的命令 / flag / await 条件必须被 CLI 实现」——新增模式或 flag 必须同步文档，否则 `npm test` 失败。
- 已实现的守卫（当前 `npm test` 全绿覆盖）：
  - `handleScreenshot` 默认 `mode = 'layout'`（cli-help.ts 文本 + 源码 `options.mode || 'layout'`）。
  - `snapshot` 默认 ASCII 图：`--no-map` 关闭、`--visual` 显式触发真实像素探针（`tests/skill-docs.test.cjs` 的 `KNOWN_HIDDEN_FLAGS` 已不含 `--trust-project`，改为真正验证该 flag 由 CLI 实现）。
  - `--trust-project` 正向解析（`tests/help.test.cjs` 断言 `options.trustProject === true`）。

## 7. Wrong vs Correct

#### Wrong
```bash
# 想稳定理解页面，却漏写 --mode（旧默认会掉进官方不稳定通道 page）
miniprogram-browser screenshot out.png --session demo
# snapshot 后假设零真实像素（旧实现会在路由变化后偷偷走一次 2500ms 不稳定通道）
```
#### Correct
```bash
# 默认即稳定通道，无需写 --mode；需要真实像素证据时再显式选 page/visual/annotate
miniprogram-browser screenshot out.png --session demo
# 非识图模型：默认 ASCII 空间图 + 文本树
miniprogram-browser snapshot -i --layout --session demo
```

---

## 附录：设计演变（已定稿，留作历史）

> 以下原属「待研究」，现已落地为本文档 §3 的已确立契约。

### R1（已定稿 → §3.2 默认 ASCII 空间图）
- 选定 **C. 混合**：文本树（结构）+ 紧凑 ASCII mini-map（空间方位），用同一 `@eN` 与文本树交叉引用，对非识图模型最完整。参数见 §3.2。

### R2（已定稿 → §3.1 / §3.3）
- 落地：**默认模式对齐稳定优先（layout）**；`snapshot` 默认不触发真实像素 probe（升级为 `--visual` opt-in）；让调用方专注任务而非截图通道细节。
