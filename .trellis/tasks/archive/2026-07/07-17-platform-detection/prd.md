# 平台识别层归一化：detectWsl / resolveEnvironment + 单测

## Goal

把散落在 `src/lib/runtime.ts` 里的「平台识别」信号收敛成单一、可测的识别层
（`src/lib/platform.ts`），让 WSL / Windows / macOS 三个环境有一处真相，
不重写已工作的路径转换/镜像逻辑。

## Background（现状债）

`runtime.ts` 当前没有 `isWsl()`。WSL 靠三个线索间接猜：
- 路径形如 `/mnt/<drive>/...`（runtime.ts:616 正则）
- 路径是 UNC `\\wsl$\...`（`isWslUncPath`，runtime.ts:633）
- 能调 `wslpath`（runtime.ts:623 spawnSync）

DevTools Host（DevTools 只装 win/mac）靠 `cliPath.endsWith('.bat')` 反推。
Runtime OS 用 `process.platform`（`session-store.ts:25/27`、`runtime.ts:1254/1775/1789`）。
识别与推断混在路径转换函数里，无「环境」一等概念。

## Requirements

- 新增 `src/lib/platform.ts`，导出纯函数：
  - `detectRuntimeOS(): 'win32' | 'darwin' | 'linux'`（包 `process.platform`）
  - `detectWsl(versionText?): boolean` —— 判据 `/proc/version` 含 `microsoft`；
    `versionText` 可注入（`options.readProcVersion` 或默认值），单测喂字符串。
    非 linux 宿主直接返回 false。
  - `detectDevtoolsHost(config): 'win32' | 'darwin'` —— `.bat` 结尾 → `win32`，否则 `darwin`。
  - `resolveEnvironment(config, options?): Environment`
    `{ runtime, devtoolsHost, isWsl, needsBridge }`，
    `needsBridge = runtime==='linux' && devtoolsHost==='win32'`。
- `buildAutomationArgs` 的 `wsl-mounted-drive` 分支改为
  `env.isWsl && String(config.projectPath||'').startsWith('/mnt/')`（推导更直白，行为不变）。
- `runtime.ts` 日志路径兜底（runtime.ts:1800 附近）改用 `resolveEnvironment`：
  非 `devtoolsHost`（裸 Linux）报明确「本环境不支持」。
- **不动**：`toWindowsPath` / `mountedDriveMatch` / `isWslUncPath` /
  `resolveDevtoolsProjectPath` / `resolveMappedDevtoolsProjectPath` 等转换/校验逻辑；
  `isWslUncPath` 仍用于拒绝 UNC 路径（runtime.ts:1114）。
- `src/lib/platform.ts` 需有单测（`tests/platform.test.cjs`），覆盖：
  - `detectWsl`（喂含 microsoft 的版本串 → true；普通 linux → false；win/darwin → false）
  - `detectDevtoolsHost`（`.bat` → win32；其他 → darwin）
  - `resolveEnvironment`（WSL = linux+win32+needsBridge；mac=darwin+darwin；
    win=win32+win32）

## Acceptance Criteria

- [ ] `src/lib/platform.ts` 存在并导出上述四个符号。
- [ ] `detectWsl` 用 `/proc/version` 含 `microsoft` 判据，非 linux 返回 false。
- [ ] `wsl-mounted-drive` 分支改用 `env.isWsl`（行为等价于原 `/mnt/` + `.bat` 组合）。
- [ ] 日志路径兜底改用 `resolveEnvironment`，裸 Linux 明确报错。
- [ ] `tests/platform.test.cjs` 全绿；`npm run build` 干净；`node --test tests/*.test.cjs` 全绿。
- [ ] 路径转换/镜像逻辑无改动（回归面仅识别层）。
- [ ] 真实 DevTools 端到端烟测本环境跳过（需在装有 DevTools 的 mac/win/WSL 上跑）。
