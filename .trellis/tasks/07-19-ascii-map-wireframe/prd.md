# PRD：ASCII 空间线框 v1

## Goal

把 `snapshot -i` 附带的 ASCII 图从「仅容器框 + 叶子中心点」升级为 **全量节点空间线框**：大块画边界、小元素标 `@eN` 数字，并带智能避让，使 agent/人能看清 UI 块面与控件外沿。

## User value

- 模型在不截图时也能理解「按钮在哪一块、底栏几个键」
- 子组件/可交互控件有边界，不再只有大容器框
- 数字尽量不重叠、不轻易变成 `*`

## Confirmed facts

- 输入已有 `rectPct`（相对 window 的 0–100%）与可选 `parentRef`
- 几何与物理 DPI 解耦；禁止 `× devicePixelRatio`
- 与语义树同一次输出；操作仍只认 `@eN`
- 旧实现：`isContainer` 才画框；叶子只标中心；碰撞直接 `*`

## Requirements

1. **全量进管线**：凡有有效 `rectPct` 的 record 都参与渲染
2. **LOD**：占格够大 → 边框；太小 → 仅中心数字
3. **可交互优先**：button/input 等阈值更宽松；label 放置 interactive 优先
4. **智能避让**：label 多候选 + 评分；最大偏移有上限；失败才 `*`
5. **框线**：树序或面积序；父子共边合并（bitmask）
6. **DPI**：只用百分比；可调 mapWidth（默认 48）
7. **API**：`renderAsciiMap(records, { viewport })` 保持；默认新算法
8. **可测**：单测覆盖 LOD、button 有框、避让、空输入

## Acceptance Criteria

- [x] 大 view 内大 button：button 有自己的边框且带数字
- [x] 极小 text：无框，仅数字
- [x] 两叶子中心原重叠：尽量错开数字，而非必现 `*`
- [x] 底栏三按钮 fixture：三个编号可见且不重叠
- [x] 输出不因「假设 dpr」改变（仅用 rectPct）
- [x] `npm run build` + `node --test tests/ascii-map.test.cjs` 全绿
- [x] skill/图例：数字=`@eN`；框=区域；`*`=避让失败

## Out of scope

- 框内写中文文案
- 物理 DPI / 终端字体建模
- 跨端通用 UI ASCII 引擎

## Notes

- 实现见 `design.md` / `implement.md`
- 在分支 `feat/ascii-map-wireframe-v1` 开发
