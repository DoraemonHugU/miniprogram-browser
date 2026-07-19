# PRD：open 成功判定与冷启动体验

## Goal

让用户/agent 能**准确判断 open 是否成功**，冷启动失败时**人话 + 真因**可读，且**不要**被成功日志误判成 AppID 失败，也不要在失败路径上被 DevTools `--debug` 全文淹没。

## User value

- `open` 失败 → 非 0 退出 + 清晰说明（已基本具备）
- 不再把「正在 Fetching AppID」的正常日志当成 AppID 缺失
- 后续 `snapshot` 在未 open 成功时提示先 open，而不是再跑一轮吵闹的 `auto`
- 冷启动仍可能受 DevTools 时序影响，但工具侧不制造假失败

## Confirmed facts（代码 + 真机）

1. **exit code**：独立运行 `open` 失败时 `OPEN_EXIT=1`，`main().catch` → `process.exit(1)`。先前「exit 0」更可能是管道/`tail` 观察误差，不是主路径必现 bug。
2. **假阳性 AppID**：`explainDevtoolsFailureRaw` 把 `Fetching AppID () permissions` 与 `AppID ()` 组合判为缺失；而**成功**的 `auto` 也会打印该行，随后才有 `Using AppID: wx…` / `✔ auto`。导致 `enableAutomation` 在 automation 实际可能已起来时仍抛「未能读取到有效 AppID」。
3. **失败输出过长**：`error.raw` 含完整 `--debug` CLI 输出；`emitCliError` 在 message≠raw 时整段打印 raw。
4. **陈旧 startupHints**：`collectDevtoolsStartupHints` 扫历史 WeappLog，可把**更早**的 41002 样本挂到本次失败 diagnostics。
5. **重复 auto**：`connectOrEnable` 在 endpoint 非 live 时总是 `enableAutomation`；open 失败后 session 可能被清，snapshot 再走 enable → 再误判/刷屏。
6. **无 project 提示**：cwd 非小程序时 `无法解析 session…` 正确，但缺「cd 到项目或传 --project」的一步到位说明。
7. **契约**：`product-contracts` 要求失败人话+raw、成功可观测；`session-contracts` 要求 doctor 失败不污染 session（open 失败 cleanup 方向一致）。

## Requirements

| ID | 要求 |
|----|------|
| R1 | **禁止**仅凭 `Fetching AppID () permissions` 判定 AppID 失败；须有明确失败信号（如 `errcode=41002` 且无成功 Using AppID，或 INVALID 等） |
| R2 | `parseAutomationCliFailure`：raw 已表明 auto 成功（如 `Using AppID` + 成功收尾）时不得当失败抛出 |
| R3 | 用户可见 raw：**截断/摘录**关键行，完整 raw 可进 JSON 字段；文本模式避免 80 行 debug 洪水 |
| R4 | open 失败 diagnostics 的 log hints **优先本次进程时间窗口**，避免整天前的 41002 误导 |
| R5 | 非 open 命令：endpoint 未 live 时，默认 **明确要求先 open**（或受控短重试），避免每次 snapshot 无脑全量 auto+debug（产品默认：先提示 open；可选以后再加「隐式重连」开关） |
| R6 | 无 project/session 时错误文案给出可执行下一步（`--project` / 进入小程序目录） |

## Acceptance Criteria

- [x] 含 `Fetching AppID () permissions` + `Using AppID: wx…` + 成功 auto 的 raw → **不**抛 AppID 缺失
- [x] 真含 `errcode=41002` / appid missing 失败且无 Using AppID 成功 → 仍人话 AppID 问题 + 保留真因
- [x] open 失败：exit ≠ 0；文本模式首屏可读（人话 + 短 raw/摘录），JSON 可含完整 raw
- [x] open 失败后 `snapshot -i --project X`：不出现「整页 debug 当唯一信号」；优先清晰「需要先 open」或短失败
- [x] 单测覆盖 R1/R2 分类；`npm run build` + 相关 `node --test` 通过
- [x] 不扩大 scope：不做永久 `@e`、不改 ASCII

## Out of scope

- 修复微信开发者工具本身的 cli server / 编译时序
- 远程 push/PR 权限
- 10 个历史 cli-behavior 全绿（可顺手不主动大改）
- 默认对所有命令做静默无限 auto 重试

## Open questions

无（R5 采用「非 open 默认先提示 open」；若以后要「snapshot 自动 rescue open」另开任务）。
