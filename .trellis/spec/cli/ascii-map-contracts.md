# CLI ASCII Map 契约（code-spec）

> 适用范围：`src/lib/ascii-map.ts`，由 `snapshot -i` 默认附带输出。
> 维护者：改动 LOD、避让、网格映射时同步本文件。

## 1. Scope / Trigger

- 触发：为语义树提供**空间线框投影**（非像素渲染）。
- 与语义树同一次 `snapshot -i` 输出；操作仍只认 `@eN`。

## 2. Signatures

```ts
renderAsciiMap(
  records: Array<{ ref, kind, rectPct?, parentRef? }>,
  options?: {
    viewport?: { w?: number; h?: number; pixelRatio?: number } // pixelRatio 忽略
    mapWidth?: number       // default 48
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

### LOD

| 条件 | 模式 |
|------|------|
| 占格够大（默认 ≥2×2 且 area≥4；interactive 更松） | `box` 画边框 |
| 太小但仍有格 | `mark` 仅数字 |
| 无效 rect | `skip` |

### Label 避让

1. interactive 优先，其次面积大
2. 候选：中心 → 十字偏移（≤ maxLabelShift）→ 框内角 → interactive 外侧
3. 多字符水平占位；冲突换候选；失败 `*`

### 输出

- 图例 + `yyy%│` + 字符行
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

- `tests/ascii-map.test.cjs`：空、套框 button、tiny mark、避让双 button、底栏三键、dpr 稳定、legacy、refDigits、LOD classify

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
