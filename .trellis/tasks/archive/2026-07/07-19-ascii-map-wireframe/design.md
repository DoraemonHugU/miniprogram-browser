# Design：ASCII 空间线框 v1

## 产品定位

ASCII map = snapshot 记录的 **空间线框投影**（非像素渲染器）。  
语义树为主、图为辅；图中数字 = `@eN` 的 N。

## 流水线

```
Normalize → Project(rectPct→CellRect) → LOD(box|mark|skip)
  → Order(tree DFS / area desc) → PaintBorders(bitmask+merge)
  → PlaceLabels(candidates+score) → Composite
```

## LOD

```
cellW/H from CellRect; area = cellW*cellH
default box if w>=2 && h>=2 && area>=4
interactive (button/input/…): w>=1 && h>=2 也可 box
else mark (center digits); impossible → skip
maxBoxDepth default 6
```

## Label 避让

候选：中心 → 十字 1 格 → 框内角 → 外侧邻接（interactive，cap maxLabelShift=2）  
顺序：interactive → 大面积 → 其他  
冲突：格占用；失败 `*`；可选丢纯 text label

## 框线

bitmask TOP|BOTTOM|LEFT|RIGHT；角 `+`；共边合并  
绘制：祖先先于后代

## DPI

只用 rectPct；禁止 × pixelRatio  
密度 = mapWidth（默认 48）与 gridH clamp 16–56

## API

```ts
renderAsciiMap(records, {
  viewport: { w, h },
  mapWidth?: number,       // default 48
  maxBoxDepth?: number,    // default 6
  maxLabelShift?: number,  // default 2
  legacy?: boolean,        // 旧算法，默认 false
})
```

## 文件

- `src/lib/ascii-map.ts` 重写（可单文件分区）
- `tests/ascii-map.test.cjs` 扩展
- `.trellis/spec/cli/ascii-map-contracts.md` code-spec
- skill 一句读法

## 风险

全画框变乱 → LOD + depth + 共边  
数字甩飞 → maxLabelShift  
输出过长 → 默认 48 列
