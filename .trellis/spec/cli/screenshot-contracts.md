# CLI 截图 / 视觉契约（code-spec）

> 适用范围：`miniprogram-browser screenshot`、`snapshot` 的视觉与结构输出通道。
> 维护者：改动 `src/miniprogram-browser.ts` 的 `handleScreenshot` / `handleSnapshot`、`src/lib/visual.ts`、`src/lib/runtime.ts` 的 `captureScreenshotToPath` 或 `src/lib/temp-artifacts.ts` 时，必须同步本文件。

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

// src/lib/temp-artifacts.ts —— 未指定输出路径时的产物分配
async function allocateTempScreenshotPath({ directory, projectName, route, mode, ... })
```

## 3. Contracts

### 3.1 截图模式 → 通道映射（关键）

| `--mode` | 产物 | 底层通道 | 稳定性 |
|----------|------|----------|--------|
| `page`   | 官方页面截图 PNG | `captureScreenshotToPath` → `miniProgram.screenshot` | 依赖 DevTools 模拟器 |
| `visual` | 页面截图 + 胶囊视觉合成 | `captureVisualScreenshot` → `pageCapture` → `captureScreenshotToPath` | 依赖 DevTools 模拟器 |
| `annotate` | 页面截图 + `@eNN` 标注叠加 | `captureScreenshotToPath` + 叠加 | 依赖 DevTools 模拟器 |
| `layout` | 语义布局图 PNG | `captureLayoutScreenshot`（Jimp + canvas 字体） | **稳定，不调官方截图** |

- **默认模式**：`resolveScreenshotMode(undefined) === 'page'`；`screenshot` 的直接语义是产出真实页面 PNG。结构图必须显式传 `--mode layout`，未知 mode 直接报错。
- `layout` 用 `collectRecordRects`（基于 `page.$$` 选择器 + 元素尺寸，**非像素**）重建结构，再纯 JS 绘制（`src/lib/visual-change.ts:111`、`src/lib/visual.ts:677`）。

### 3.2 文本结构输出（非视觉，供非识图模型）

- `snapshot` → compact 语义树 + 紧凑 ASCII mini-map；语义树按 DOM 嵌套深度缩进，图中数字映射同一批 `@eN`。
- 默认会查询 ref 的比例 rect 来生成 ASCII，但不会把坐标重复写进文本行；`--no-map` 关闭图并跳过这批 rect 查询。
- `snapshot --layout` → 在默认输出基础上为每个 ref 追加比例 rect（如 `@e20 [button] 工具箱 {x:10.4,y:82.1,w:24.5,h:6.8}`）。
  - `GRID_W = 32`；行高 `clamp(round(GRID_W × viewportH / viewportW × 0.5), 12, 24)`，连续空行折叠为一行 `...|`。
  - 输出只使用 ASCII 字符；数字对应 `@eN`，`*` 表示标签碰撞，`>99` 折叠为 `aN`/`bN`。
  - `--layout --no-map` 保留比例 rect，但关闭 ASCII 图；单独 `--no-map` 返回无坐标语义树。

### 3.3 snapshot 的真实像素副作用（已收敛为显式 opt-in）

- `handleSnapshot` 仅在 `options.visual === true` 且 `scopeRef` 为空且（无 `lastVisualProbe` 或 route 变化或存在 `pendingVisualAction`）时，才触发 `captureVisualProbeForSnapshot`。
- 该 probe 走 `captureScreenshotToPath(..., 2500)`（真实像素，2500ms，`src/miniprogram-browser.ts`）。
- **含义**：默认 `snapshot` 只增加结构几何查询，不触发真实像素通道；`--layout` 仅控制坐标是否写入文本。历史 `--visual` 兼容入口才会触发真实像素探针，且不属于主路径。

### 3.4 默认截图产物路径与文件名

- `screenshot` 未指定输出路径时，使用 `os.tmpdir()/miniprogram-browser`（Linux 默认即 `/tmp/miniprogram-browser`）；已配置的 `tempScreenshotDir` 仍可作为内部目录覆盖。
- 默认文件名采用短、可读的组合：`mpb-<project>-<page>-<mode>.png`。标准路由尾部为 `index` 时使用上一级页面名；session、时间戳和 route hash 不进入文件名。
- 分配基础名时使用原子 `open(path, 'wx')`；若文件已存在，依次尝试 `-1`、`-2`……，并发进程不会互相覆盖。显式文件路径不改名、不参与该避让策略。
- 显式文件路径通过宿主平台的 `path.resolve(cwd, input)` 解析：相对路径基于当前工作目录，绝对路径保持绝对语义；父目录由 CLI 递归创建。
- 输出路径是位置参数 `screenshot [path]`；`--path` 不是别名，误用时返回 `CLI_USAGE_ERROR`，不得静默回落到默认临时目录。
- 显式路径若指向已有目录，或原始输入以当前平台目录分隔符结尾，则复用默认短文件名和原子避让规则在该目录内分配 PNG。Windows 同时接受 `/` 和 `\\` 作为尾分隔符。
- 不存在且没有尾分隔符的路径仍按文件路径处理，兼容原有无扩展名输出文件。
- `snapshot --visual` 的内部视觉探针也使用同一分配器，避免用时间戳和随机长文件名制造不可读产物。
- 显式输出路径若位于当前小程序项目目录内，截图结果须返回 notice：写入文件可能触发微信开发者工具重新编译并重置页面状态；工具不阻止写入，但应建议省略路径或改到项目目录外。

## 4. Validation & Error Matrix

| 条件 | 结果 |
|------|------|
| `--mode` 为未知值 | 直接报 `Unsupported screenshot mode`，不猜测、不降级 |
| `--focus` 引用不存在的 ref | `resolveFocusTargets` 抛 `Unknown focus refs: ...`（`src/lib/visual.ts:757`） |
| 官方截图超时 | `captureScreenshotToPath` 抛超时错误（page/visual/annotate 失败；layout 不受影响） |
| `--trust-project` 传入 | `parseArgs` 正向分支置 `options.trustProject = true`（`src/lib/cli-io.ts`）；反向 `--no-trust-project` 置 `false`。二者均为可选 escape hatch，默认信任。 |
| 未指定截图路径 | 写入系统临时目录，使用短组合名；已有同名文件则自动递增后缀，不覆盖旧文件 |
| 误写 `--path <value>` | 立即返回 `CLI_USAGE_ERROR`，提示改用 `screenshot [path]` |
| 相对/绝对文件路径 | 按当前宿主平台解析为绝对路径，递归创建父目录并保留用户文件名 |
| 已有目录或尾分隔符新目录 | 在目标目录生成短组合名；目录不存在时递归创建，同名文件自动避让 |
| 显式截图路径在项目目录内 | 截图照常完成，并在文本/JSON 结果中提示可能重新编译与状态重置 |

## 5. Good / Base / Bad Cases

- **Good**：需要真实页面图片 → `screenshot`；需要结构理解 → `snapshot` 或显式 `screenshot --mode layout`。
- **Base**：未指定模式 → 默认 `page`，产出官方页面 PNG。
- **Bad**：把默认 `screenshot` 当结构图；或真实截图失败后静默拿 layout 冒充真实页面证据。

## 6. Tests Required

- `tests/skill-docs.test.cjs` 已守卫「SKILL.md 引用的命令 / flag / await 条件必须被 CLI 实现」——新增模式或 flag 必须同步文档，否则 `npm test` 失败。
- `tests/temp-artifacts.test.cjs` 覆盖默认临时目录、短文件名、已有文件递增和并发分配唯一性。
- `tests/temp-artifacts.test.cjs` 覆盖项目内路径识别、warning 文案与项目外无 warning。
- `tests/temp-artifacts.test.cjs` 通过注入 `path.posix` / `path.win32` 覆盖相对与绝对路径，并覆盖已有目录、尾分隔符新目录和父目录创建。
- 已实现的守卫（由相关测试覆盖）：
  - `resolveScreenshotMode` 默认返回 `page`，未知 mode 报错；`tests/help.test.cjs` 覆盖。
  - `resolveSnapshotLayoutPolicy`：默认查 rect 并输出 ASCII，但文本行不重复坐标；`--layout` 追加坐标；`--no-map` 关闭默认图；`tests/help.test.cjs` 覆盖。
  - `--visual` 显式触发真实像素探针。
  - `--trust-project` 正向解析（`tests/help.test.cjs` 断言 `options.trustProject === true`）。

## 7. Wrong vs Correct

#### Wrong
```bash
# 只需要结构，却把默认真实截图当作结构接口
miniprogram-browser screenshot --session demo
# 真实截图失败后拿 layout 冒充真实页面证据
miniprogram-browser screenshot --mode layout --session demo
```
#### Correct
```bash
# 默认产出真实页面 PNG
miniprogram-browser screenshot --session demo
# 结构理解使用 snapshot；确实需要结构图再显式 layout
miniprogram-browser snapshot --session demo
miniprogram-browser screenshot --mode layout --session demo
```

---

## 附录：设计演变（已定稿，留作历史）

> 以下原属「待研究」，现已落地为本文档 §3 的已确立契约。

### R1（已定稿 → §3.2 默认 ASCII 空间图）
- 默认语义树同时带紧凑 ASCII mini-map；精确比例 rect 只在 `--layout` 时写入文本。参数见 §3.2。

### R2（已定稿 → §3.1 / §3.3）
- 最终落地：`screenshot` 默认对齐真实截图语义（`page`）；结构图显式使用 `layout`。`snapshot` 默认不触发真实像素 probe（仅 `--visual` opt-in）。
