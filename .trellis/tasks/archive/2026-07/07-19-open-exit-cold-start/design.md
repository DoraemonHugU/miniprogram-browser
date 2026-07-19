# Design：open 成功判定与冷启动体验

## 问题拆解

```
用户: open / snapshot
        │
        ▼
connectOrEnable
  live? ──yes──► connect only
    │ no
    ▼
enableAutomation (devtools auto --debug)
        │
        ▼
parseAutomationCliFailure(raw)  ← 假阳性在这里
        │
   误判 AppID ──► throw 大 raw
        │
   真失败/真成功
```

### 根因 A：AppID 假阳性（P0）

`explainDevtoolsFailureRaw`（`runtime-cli-shared.ts`）类似：

- 匹配 `Fetching AppID () permissions` **且** `AppID ()`  
- 成功路径同样打印 `Fetching AppID () permissions`，再打印 `Using AppID: wx…`

→ 成功 raw 被当成失败 → enable 抛错 → open 失败；有时端口其实已监听，状态更乱。

**修法：**

1. 若 raw 匹配成功信号（如 `/Using AppID:\s*wx\w+/i` 或 `✔ auto` / `long connection established` 且无后续 INVALID），**不要**走 AppID 缺失解释。  
2. AppID 缺失仅当：`errcode=41002` / `appid missing` / 明确失败，且**没有** Using AppID 成功行。  
3. `parseAutomationCliFailure`：在 status≠0 前先检测「auto 已成功」→ return null。

### 根因 B：raw 噪音（P0/P1）

`runDevtoolsCli` 合并 stdout+stderr 为 raw；auto 带 `--debug`。  
`emitCliError` 全文打印 raw。

**修法：**

- 新增 `summarizeDevtoolsCliRaw(raw, { maxLines })`：保留 `[error]`、INVALID、41002、Using AppID、start cli server error 等行；默认文本模式 15–25 行。  
- JSON：`error.raw` 可保留全文或 `rawExcerpt` + 可选 `rawFull`（为少破契约，建议 `raw` 改为摘录，`diagnostics.rawFull` 可选）。  
- 与 product-contracts「保留真因」一致：摘录须含真因行，不是删掉。

### 根因 C：陈旧 startupHints（P1）

`collectDevtoolsStartupHints` 扫 WeappLog 文件，无时间过滤。

**修法：**

- 仅采用 mtime 近 N 分钟或行内时间戳 ≥ open 开始时间 − 2min 的样本。  
- 或 open 失败时优先用 **本次 enable 的 raw** 分类，日志 hints 降级为补充。

### 根因 D：失败后 snapshot 再 auto（P1）

`connectOrEnable`：非 live → 总 enable。

**产品策略（已定）：**

- **open/connect/doctor**：可以 enable（本职）。  
- **其它命令**（snapshot/click/…）：若配置了 autoPort 但 not live，且无显式「rescue」：  
  - 抛清晰错误：`自动化未连接，请先 open --project …`（带 session 名若有）  
  - **不要**默认再跑全量 auto+debug  

可选后续：`MINIPROGRAM_BROWSER_AUTO_RESCUE=1` 再 enable（本任务不做开关也可，先硬策略）。

### 根因 E：无 project 文案（P2）

`无法解析 session：…` 已有方向，补一句：`请在小程序项目目录执行，或传 --project <小程序根>`。

## 模块落点

| 模块 | 改动 |
|------|------|
| `src/lib/runtime-cli-shared.ts` | 假阳性修复；raw 摘录；成功检测 |
| `src/lib/runtime-connect.ts` | 非 open 路径策略（需传 options 如 `allowEnable`） |
| `src/miniprogram-browser.ts` | withMiniProgram/open 传 `allowEnable`；无 project 文案；hints 时间窗 |
| `src/lib/runtime-cli.ts` | 可选：enable 超时/结果与成功检测对齐 |
| `tests/runtime.test.cjs` | 成功 raw 不 fail；41002 真失败仍 fail；摘录测试 |

## withMiniProgram 选项

```ts
connectOrEnable(config, {
  allowEnable: command === 'open' || command === 'connect' || command === 'doctor' || options.forceEnable,
  ...
})
```

默认 `allowEnable=false` 更安全；open 显式 true。  
**兼容：** 若 false 且 not live → 错误信息指导 open，而不是静默挂死。

## 风险

- 真 AppID 空项目：仍须能报失败（依赖 41002 等真信号）。  
- 有人依赖 snapshot 隐式拉起：行为变更 → skill 已写 open 先；help 可补一句。  
- raw 摘录过狠丢真因：单测固定保留关键词行。

## 验证

```bash
npm run build
node --test tests/runtime.test.cjs  # 名称过滤 failure/AppID/raw
# 真机：open 失败 exit 1；含 Using AppID 的 raw 不误杀；snapshot 未 open 时短错误
```
