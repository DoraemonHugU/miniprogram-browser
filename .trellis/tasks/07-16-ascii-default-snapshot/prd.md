# snapshot 默认 ASCII 空间图 + 通道/flag 修复

## Goal

让 `miniprogram-browser` 的「理解本页」入口对非识图模型最友好、且默认走安全通道：

1. `snapshot` 默认输出 = 结构化 ref 文本树 + 紧凑 ASCII 空间 mini-map（不依赖官方截图通道，像素免费）。
2. 明确 SKILL.md 模型分派约定：非识图模型默认用 ASCII（`snapshot`），识图模型用真实图片（`screenshot --mode page/visual/annotate`）。
3. 移除 `snapshot` 内藏着的 2500ms 真实像素 probe（只在显式要真实像素时触发）。
4. `screenshot` 默认模式对齐「稳定优先」，不默认可不稳定的 `page`。
5. 清理 `--trust-project` 陷阱 flag（正向分支会抛 `CLI_USAGE_ERROR`）。

设计已在用户侧定稿（方案 C：文本树 + ASCII mini-map 混合）。本任务负责落地与测试。

## Requirements

- ASCII mini-map 由已稳定的 `rectPct`（选择器 + `element.size()/offset()` 比例坐标，来自 `collectRecordRects`）渲染，不触碰 `miniProgram.screenshot`。
- 文本树与 ASCII 图通过同一 `@eN` ref 交叉引用；图提供空间方位，树提供结构与文本标签。
- 关键命令（`goto/click/fill/screenshot/snapshot`）默认挂安全等待条件；调用方无需记得写 `--await`（`--no-await` 仍可关闭）。
- 改动后 `npm run build` + `npm test` 全绿；`tests/skill-docs.test.cjs` 守卫（SKILL.md 命令/flag/await 条件必须被 CLI 实现）不被破坏。

## Acceptance Criteria

- [ ] `snapshot -i`（无 `--no-map`）输出包含 ASCII 空间图块（带图例 `x→右 y→下`、行标注 y% 区段、`@eN` 数字标记、容器边框盒）。
- [ ] ASCII 渲染消费 `rectPct`，单测可断言「无 `rectPct` 的元素不出现在网格 / 重叠叶子冲突时打 `*`」。
- [ ] 同页 `snapshot` 连续两次不触发 `captureScreenshotToPath` / `createVisualProbe`（除非显式 `--visual`）。
- [ ] `screenshot` 默认 `mode` 不再直接绑定不稳定的 `page`（改稳定优先或显式分派）。
- [ ] `--trust-project`（正向）不再抛 `CLI_USAGE_ERROR`；`--no-trust-project` 仍生效；`tests/help.test.cjs` 与 `tests/runtime.test.cjs` 相关断言对应更新。
- [ ] SKILL.md 新增/更新「模型分派」约定：非识图→ASCII、识图→真实图片；无新增未实现的命令/flag。
- [ ] `.trellis/spec/cli/screenshot-contracts.md` 把已定稿的 R1/R2 从「待研究」提升为确立契约（含 ASCII 渲染参数表与通道默认值）。

## Child Tasks

- `07-16-ascii-map-renderer` — ASCII 空间 mini-map 渲染器（纯函数 + 单测）。
- `07-16-snapshot-ascii-default` — `snapshot` 默认加 ASCII 图、移除隐藏像素 probe。
- `07-16-screenshot-default-mode` — `screenshot` 默认模式对齐稳定优先。
- `07-16-trust-flag-and-skill` — 清理 `--trust-project` 陷阱 + SKILL.md 模型分派约定。

## Notes

- 子任务是可独立规划/实现/验收/归档的单元；父任务拥有总验收与集成评审。
- 优先级由用户定：`snapshot` ASCII 最高（默认），真实图片留给识图模型。
