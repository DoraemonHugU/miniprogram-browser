# Implement：open 成功判定与冷启动体验

## 顺序

1. **TDD** `tests/runtime.test.cjs`  
   - raw 含 `Fetching AppID () permissions` + `Using AppID: wx…` + auto 成功 → `parseAutomationCliFailure` 为 null  
   - raw 含 `errcode=41002` 无 Using AppID → 仍有 failure 且 message 含 AppID  
   - `summarizeDevtoolsCliRaw` / 摘录保留 error 行  

2. **修** `src/lib/runtime-cli-shared.ts`（R1/R2/R3）

3. **修** `connectOrEnable` + 调用方 `allowEnable`（R5）

4. **修** open 失败 hints 时间窗 + 无 project 文案（R4/R6）

5. **验证** build + 测试；可选真机 open/snapshot  

6. **文档** skill 一句：请先 open；非 open 不会自动拉起 automation（若行为变更）

## 风险文件

- `runtime-cli-shared.ts`（分类核心）
- `runtime-connect.ts`（连接策略）
- `miniprogram-browser.ts`（emit/文案/hints）

## Rollback

revert 上述文件；测试一并回退。
