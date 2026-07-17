# 执行计划：snapshot 默认 ASCII 空间图 + 通道/flag 修复

> 父任务执行计划。子任务见各 `07-16-*` 目录，可独立验收。

## 执行顺序（依赖关系）

```
1. ascii-map-renderer      (无依赖，先建纯函数 + 单测)
2. snapshot-ascii-default  (依赖 1 的 renderAsciiMap)
3. screenshot-default-mode  (独立)
4. trust-flag-and-skill    (独立；含 SKILL.md 更新)
5. 集成：spec 提级 + 全量构建测试
```

## 总 Checklist

- [ ] **Step 1 — ASCII 渲染器**（`src/lib/ascii-map.ts`）
  - 新建纯函数 `renderAsciiMap(records, options)`：消费 `rectPct`，按 §设计1 参数表与分层渲染产出图块。
  - 在 `src/miniprogram-browser.ts` 的导出 `module.exports` 加入 `renderAsciiMap`（供测试）。
  - 新建 `tests/ascii-map.test.cjs`：双 ref、重叠 `*`、空 records、竖屏 `GRID_H` 范围。
  - 验证：`npm run build && node --test tests/ascii-map.test.cjs` 绿。

- [ ] **Step 2 — snapshot 默认加图 + 去探针**
  - `cli-io.ts` `booleanFlags` 加 `noMap`（默认 `noMap=false` → 图默认开）；`--map` 显式开。
  - `handleSnapshot`（miniprogram-browser.ts:1776）：`--layout` 或 `!noMap` 时 collect+merge rectPct，tree lines 后追加 `renderAsciiMap(records)`。
  - `shouldAttemptVisualProbe`（miniprogram-browser.ts:161）加 `options` 参数，仅 `options.visual` 为真才触发；调用处（:1801）传入 `options`。
  - `summarizeSnapshotPayload`（cli-payload.ts:31）把图串放进 `summary.map`（非 json 走 `lines` 追加；json 走 `summary.map`）。
  - 更新 `tests/help.test.cjs:566-570` 四个断言（route 变化但无 `--visual` → `false`）。
  - 验证：`npm run build && npm test`（全量）绿。

- [ ] **Step 3 — screenshot 默认稳定优先**
  - `handleScreenshot`（miniprogram-browser.ts:2264）：`const mode = options.mode || 'layout'`。
  - `cli-help.ts:62` `默认 page` → `默认 layout`；screenshot 段说明同步。
  - `tests/help.test.cjs` screenshot 段断言同步；检查 `tests/build.test.cjs`、`tests/skill-docs.test.cjs` 是否引用 `page` 默认。
  - 验证：全量测试绿。

- [ ] **Step 4 — trust flag + SKILL.md**
  - `cli-io.ts:92` 加 `if (key === 'trust-project') { options.trustProject = true; continue }`。
  - `tests/skill-docs.test.cjs:34` 从 `KNOWN_HIDDEN_FLAGS` 移除 `--trust-project`。
  - `tests/help.test.cjs:160` 保留；新增 `--trust-project` 设 `true` 不报错断言。
  - SKILL.md 新增「模型分派」小节（非识图→ASCII / 识图→真实图片），并更新「最常用流程」「screenshot」默认模式描述。

- [ ] **Step 5 — 集成与 spec 提级**
  - `.trellis/spec/cli/screenshot-contracts.md`：把附录 R1/R2 提为确立契约，写入 ASCII 参数表 §设计1 + 默认通道值（snapshot 默认 ASCII、screenshot 默认 layout、snapshot 默认不藏 probe）。
  - `npm run build && npm test` 全绿；向用户报告跳过项（真实 DevTools 冒烟需手动）。

## 验证门（每步必跑）

```bash
npm run build
node --test tests/ascii-map.test.cjs   # step1
npm test                              # step2-5 后全量
```

## Rollback

- 任何一步测试不绿 → 该步回退，不带着红灯进下一步。
- `git` 未提交前可整体 `git checkout` 丢弃；本任务不自动 commit，完成后交用户审阅再 commit。

## 不做的范围

- 不引入新依赖（ASCII 渲染纯 `String`）。
- 不改动真实截图通道 `captureScreenshotToPath` 本身（只是默认不再默然走它）。
- 不重构 `snapshotInteractive` / `collectRecordRects` 内部（只新增接线与消费）。
