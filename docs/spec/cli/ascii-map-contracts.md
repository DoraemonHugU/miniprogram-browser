# CLI ASCII Map 契约（code-spec）

> 适用范围：`src/lib/ascii-map.ts`，由默认 `snapshot` 输出。
> 维护者：改动 LOD、避让、网格映射时同步本文件。

## 1. Scope / Trigger

- 触发：为语义树提供**空间线框投影**（非像素渲染）。
- 与语义树同一次 `snapshot` 输出；操作仍只认 `@eN`。`--layout` 只负责把精确 rect 追加到语义文本。

## 2. Signatures

```ts
renderAsciiMap(
  records: Array<{ ref, kind, rectPct?, parentRef? }>,
  options?: {
    viewport?: { w?: number; h?: number; pixelRatio?: number } // pixelRatio 忽略
    mapWidth?: number       // default 32
    maxBoxDepth?: number    // default 6
    maxLabelShift?: number  // default 2
    legacy?: boolean        // 旧：仅容器框
  }
): string
```

## 3. Contracts

### 几何

- `rectPct = {x,y,w,h}` 相对 **window** 的 0–100%。
- **禁止** `× devicePixelRatio`；密度只调 `mapWidth` / `gridH`。
- 同一 selector 命中多个节点时，snapshot record 必须保存从 0 开始的 selector occurrence index；几何查询按该 index 取对应元素，禁止所有重复控件复用第一个节点的 rect。
- 点击/读取重解析必须使用同一 occurrence 语义：先按节点派生 selector 过滤同标签候选，再使用 occurrence；相同文案不构成唯一身份时不得覆盖 occurrence index。

### LOD

| 条件 | 模式 |
|------|------|
| container 占格够大（默认 ≥2×2 且 area≥4）或 interactive 达到更松阈值 | `box` 画边框 |
| text / label / 普通叶子，不论面积 | `mark` 仅数字 |
| 太小但仍有格 | `mark` 仅数字 |
| 无效 rect | `skip` |

### Label 避让

1. interactive 优先，其次面积大
2. 候选：中心 → 十字偏移（≤ maxLabelShift）→ 框内角 → interactive 外侧
3. 多字符水平占位；冲突换候选；失败 `*`

### 输出

- 纯 ASCII 图例 + `yyy%|` + 字符行
- 默认宽 32；行高 `clamp(round(32 × viewportH / viewportW × 0.5), 12, 24)`
- 连续空白行折叠为一个 `...|`，非空行保留自身 y 百分比，避免上下文被空白占满
- 数字字符 = `@eN` 的 N（>99 折叠 a1…）
- 框字符：`+` `-` `|`

## 4. Validation & Error Matrix

| 条件 | 结果 |
|------|------|
| records 空 / 全无 rectPct | `''` |
| legacy:true | 仅 container 画框 |
| viewport 缺省 | 按 375×812 推 gridH |

## 5. Good / Base / Bad

- **Good**：大 button 有独立框 + 数字；底栏三键三号可见
- **Base**：小 text 仅数字
- **Bad**：中心重叠直接 `*` 且不尝试避让（旧行为）

## 6. Tests Required

- `tests/ascii-map.test.cjs`：空、套框 button、普通 text 始终 mark、空行折叠、避让双 button、底栏三键、dpr 稳定、legacy、refDigits、LOD classify
- `tests/runtime.test.cjs` / `tests/visual-change.test.cjs`：重复 selector 保留独立 index，并映射为不同控件 rect
- `tests/runtime.test.cjs`：同标签混有 id 控件、且多个通用 selector 控件文案相同时，后一个 ref 仍命中对应 occurrence

## 7. Wrong vs Correct

#### Wrong
```ts
rect.x *= systemInfo.pixelRatio  // 破坏百分比几何
if (isContainer(r)) drawBorder() // 漏掉大 button
if (center occupied) cell = '*'  // 不尝试偏移
```

#### Correct
```ts
col = floor(rectPct.x/100 * mapWidth)
if (classifyLod(...) === 'box') paintBorder(...)  // 含 button
placeLabels with candidates before '*'
```
