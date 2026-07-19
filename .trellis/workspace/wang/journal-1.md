# Journal - wang (Part 1)

> AI development session journal
> Started: 2026-07-16

---



## Session 1: snapshot 默认 ASCII 空间图 + 通道/flag 修复

**Date**: 2026-07-17
**Task**: snapshot 默认 ASCII 空间图 + 通道/flag 修复
**Branch**: `main`

### Summary

实现 snapshot 默认 ASCII mini-map（基于 rectPct 比例坐标，零真实像素），新增 --no-map/--visual；screenshot 默认 layout（稳定通道）；--trust-project 正向解析合法化；SKILL.md 增补模型分派段并同步契约。审查 9 项全 PASS，244 node + 19 图处理测试全绿。真实 DevTools 端到端烟测本环境跳过。

### Main Changes

- Detailed change bullets were not supplied; see the summary above.

### Git Commits

| Hash | Message |
|------|---------|
| `9cff864` | (see git log) |

### Testing

- Validation was not recorded for this session.

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 2: 平台识别层归一化：detectWsl / resolveEnvironment

**Date**: 2026-07-17
**Task**: 平台识别层归一化：detectWsl / resolveEnvironment
**Branch**: `main`

### Summary

新增 src/lib/platform.ts，把 WSL/Windows/macOS 三环境识别收敛为单一 Environment 模型；wsl-mounted-drive 分支改用 env.isWsl，日志兜底报错补充 runtime/devtoolsHost 维度。新增 11 用例平台单测，全量 node 测试 255 全绿。

### Main Changes


### Context

原 runtime.ts 无 isWsl()，WSL 靠三处散落信号间接猜（/mnt/ 前缀、UNC 正则、wslpath）。识别与路径转换耦合。

### Changes

- 新增 src/lib/platform.ts：detectRuntimeOS / detectWsl（/proc/version 含 microsoft）/ detectDevtoolsHost（cliPath 是否 .bat）/ resolveEnvironment（Environment 模型）。
- runtime.ts buildAutomationArgs 的 wsl-mounted-drive 分支由 hasWindowsBundle 改为 env.isWsl；resolveDevtoolsLogRoot 兜底报错补充 runtime/devtoolsHost。
- 路径转换/镜像逻辑（toWindowsPath、isWslUncPath、resolveDevtoolsProjectPath 等）保持不动，回归面仅识别层。
- 新增 tests/platform.test.cjs（11 用例）；新增 .trellis/spec/cli/platform-detection.md。

### Testing

- node --test tests/*.test.cjs：255 pass / 0 fail（含新增 11 平台用例）。
- npm run build 干净。
- 跳过：真实 DevTools 端到端烟测（open → snapshot -i → screenshot --mode layout）需 mac/win/WSL 宿主，本环境无 DevTools。


### Git Commits

| Hash | Message |
|------|---------|
| `6f2d988` | (see git log) |

### Testing

- Validation was not recorded for this session.

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 3: runtime.ts 拆包重构 + .bat→env 迁移 + 严格 TS 检查

**Date**: 2026-07-17
**Task**: runtime.ts 拆包重构 + .bat→env 迁移 + 严格 TS 检查
**Branch**: `main`

### Summary

完成三件事：
1. 修复 2 个 .bat→env 迁移测试（注入 runtime: darwin）
2. runtime.ts 从 3589 行拆包为 5 个文件：runtime.ts(核心)、runtime-windows.ts(路径桥接)、runtime-cli.ts(CLI 调用)、runtime-cli-shared.ts(错误解析)、runtime-logs.ts(日志发现)
3. 添加 npm run typecheck:strict 命令（--strict 模式检查）
4. 更新 platform-detection code-spec，新增 injectable options 契约
5. 更新 platform.test 覆盖 injectable RuntimeOS 测试

### Main Changes

- Detailed change bullets were not supplied; see the summary above.

### Git Commits

| Hash | Message |
|------|---------|
| `505afd5` | (see git log) |
| `f371f06` | (see git log) |

### Testing

- Validation was not recorded for this session.

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 4: 完成 runtime.ts 终极拆包重构 + 冗余清理 + code-spec 更新

**Date**: 2026-07-18
**Task**: 完成 runtime.ts 终极拆包重构 + 冗余清理 + code-spec 更新
**Branch**: `main`

### Summary

从 2603 行拆为 10 个专注子模块（runtime-{core,snapshot,state,wait,bridge,timeline,resolve,connect,windows,cli,cli-shared,logs}），runtime.ts 缩减至 120 行纯导出入口。清理所有未使用 import（fs,crypto,path,spawnSync 等）。保留 10 个需真实环境的预存测试不改动。测试基线一致：247 pass / 10 fail。

### Main Changes

- Detailed change bullets were not supplied; see the summary above.

### Git Commits

| Hash | Message |
|------|---------|
| `c97a0e2` | (see git log) |

### Testing

- Validation was not recorded for this session.

### Status

[OK] **Completed**

### Next Steps

- None - task complete

## 2026-07-19 session-refactor E2E 闭环

- goto 前导 `/` 修复 + session/runtime 解耦已落地
- E2E 暴露两处闭环缺口并已修：
  1. 后续命令需 `bindSessionRuntimeFromPool` 回绑 autoPort
  2. `connectOrEnable` 必须优先复用 live endpoint，禁止重复 auto
- 真实 DevTools：open/snapshot/get/goto/click 全通；session 文件无 autoPort
- 测试基线维持 224 pass / 10 fail

## 2026-07-19 open-exit-cold-start

Task: `.trellis/tasks/07-19-open-exit-cold-start`

Done:
- R1/R2: `explainDevtoolsFailureRaw` / `parseAutomationCliFailure` 不再把成功路径 `Fetching AppID () permissions` + `Using AppID` 误判为 AppID 缺失；真 41002 仍人话。
- R3: `summarizeDevtoolsCliRaw` + 文本 `emitCliError` 摘录；JSON 仍可带完整 raw。
- R5: `connectOrEnable` 默认 `allowEnable=false`；`open/connect` 经 `connectOpenSession` 传 true；非 live 业务命令提示先 open。
- R4: `collectDevtoolsStartupHints` 过滤 mtime 超 10 分钟的日志文件。
- R6: 无 session/project 错误文案补可执行下一步；skill 写明先 open。
- Verify: `npm run build`；`tests/runtime.test.cjs` 79 pass；`core`/`skill-docs` pass；`cli-behavior` 仍 10 fail（基线，本任务 out of scope）。


## Session 5: open 冷启动与失败分类

**Date**: 2026-07-19
**Task**: open 冷启动与失败分类
**Branch**: `feat/ascii-map-wireframe-v1`

### Summary

修复 AppID 假阳性（Fetching≠缺失）；文本 raw 摘录；非 open 默认 allowEnable=false 提示先 open；startupHints 10 分钟时间窗；同步 product/session contracts；runtime 79 测通过。

### Main Changes

- Detailed change bullets were not supplied; see the summary above.

### Git Commits

| Hash | Message |
|------|---------|
| `08fa0aa` | (see git log) |
| `7b2787e` | (see git log) |

### Testing

- Validation was not recorded for this session.

### Status

[OK] **Completed**

### Next Steps

- None - task complete

## 2026-07-19 cli-behavior-cross-platform

- 根因：失败 open 清 session；WSL fake CLI 缺 node.exe；withOpenTimeout 未接线；kill 未回绑 autoPort
- 修：createFakeDevtoolsCli + seedSession；open 接 withOpenTimeout；kill bindSessionRuntimeFromPool(requireLive:false)
- 验证：cli-behavior 18/18；runtime+core 全绿


## Session 6: cli-behavior 跨平台测试修复

**Date**: 2026-07-19
**Task**: cli-behavior 跨平台测试修复
**Branch**: `feat/ascii-map-wireframe-v1`

### Summary

createFakeDevtoolsCli + seedSession 修 10 个失败用例；open 接 withOpenTimeout；kill 回绑 autoPort；cli-behavior 18/18。

### Main Changes

- Detailed change bullets were not supplied; see the summary above.

### Git Commits

| Hash | Message |
|------|---------|
| `e4a090d` | (see git log) |
| `1e40d15` | (see git log) |

### Testing

- Validation was not recorded for this session.

### Status

[OK] **Completed**

### Next Steps

- None - task complete
