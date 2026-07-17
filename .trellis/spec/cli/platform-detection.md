# CLI 平台识别契约（code-spec）

> 适用范围：`src/lib/platform.ts` 的平台 / 环境识别层。
> 维护者：改动 `platform.ts` 或 `runtime.ts` 中引用 `resolveEnvironment` 的分支时，必须同步本文件。

## 1. Scope / Trigger

- 触发：WSL / Windows / macOS 三环境的识别是跨层契约（CLI 运行宿主 → DevTools 安装宿主 → 路径桥接/镜像策略）。
- 背景（已确立事实）：原 `runtime.ts` 无 `isWsl()`，WSL 靠三处散落信号间接猜：`/mnt/<drive>/` 前缀、`\\wsl$\` UNC 正则、能否跑 `wslpath`。识别与路径转换耦合，无「环境」一等概念。
- 本契约把识别收敛为单一 `Environment` 模型，路径转换/镜像逻辑不动，缩小回归面。

## 2. Signatures

```ts
// src/lib/platform.ts
type RuntimeOS = 'win32' | 'darwin' | 'linux'        // CLI 进程所在 OS（process.platform）
type DevtoolsHostOS = 'win32' | 'darwin'             // DevTools 只装 win/mac
interface Environment {
  runtime: RuntimeOS
  devtoolsHost: DevtoolsHostOS
  isWsl: boolean        // runtime=linux 且（/proc/version 含 microsoft 或 WSL_DISTRO_NAME 非空）
  needsBridge: boolean  // isWsl（WSL 恒需路径翻译 + 受控镜像桥接）
}

function detectRuntimeOS(platform?: string): RuntimeOS
function detectWsl(versionText?: string, options?: AnyRecord): boolean
function detectDevtoolsHost(runtime: RuntimeOS): DevtoolsHostOS
function resolveEnvironment(config: AnyRecord, options?: AnyRecord): Environment
```

所有检测函数均可注入（单测不依赖真实 `process.platform` / `/proc/version` / 环境变量）：
- `detectRuntimeOS(platform?)`：`platform` 缺省取 `process.platform`。
- `detectWsl(versionText?, { runtime, wslDistroName })`：`versionText` 缺省读真实 `/proc/version`；`runtime` 缺省取 `process.platform`；`wslDistroName` 缺省取 `process.env.WSL_DISTRO_NAME`。
- `resolveEnvironment(config, { runtime, readProcVersion, wslDistroName })`：三个维度均可注入。

## 3. Contracts

### 3.1 两维度模型（关键）

| 维度 | 来源 | 取值 |
|------|------|------|
| `runtime` | `process.platform` | win32 / darwin / linux |
| `devtoolsHost` | **由 runtime 推导** | linux → win32（桥接 Windows DevTools）；win32 → win32；darwin → darwin |

- **WSL** = `runtime=linux` 且 `devtoolsHost=win32` → `needsBridge=true`，需路径翻译 + 受控镜像桥接。
- **裸 linux**（runtime=linux，无 WSL 信号）→ `devtoolsHost` 仍按 runtime 推导为 `win32`，但 `needsBridge=false`（无可达 DevTools）；依赖上层兜底报错「本环境不支持」。

### 3.2 WSL 判据（关键）

- 判据：`runtime==='linux'` 且以下任一为真：
  - `/proc/version` 含 `microsoft`（不区分大小写，主信号）—— 精简镜像也在；
  - `process.env.WSL_DISTRO_NAME` 非空（辅助信号）—— WSL 始终注入，裸 linux 不会设置。
- 为什么不用「能跑 wslpath」：精简 WSL 镜像可能缺 `wslpath`，但 `/proc/version` 一定在。
- `versionText` / `wslDistroName` 可注入（单测喂字符串，不依赖真实文件系统或环境）；缺省读真实 `/proc/version`，读不到返回 `''` → 仅看辅助信号。
- 非 linux 宿主 `detectWsl` 直接返回 `false`，**不读** `/proc/version`。

### 3.3 DevTools Host 判据

- **由 `runtime` 推导**：`runtime==='linux' → 'win32'`（WSL 桥接 Windows DevTools）；`win32 → 'win32'`；`darwin → 'darwin'`。
- 设计动机：旧版用 `cliPath.endsWith('.bat')` 判定 Windows 包，但 Windows 上 `.exe` 包裹（非 .bat 入口）会被误判为 mac。`devtoolsHost` 本质是「DevTools 装在哪」，由运行宿主决定，与 CLI 入口名无关，故改为 runtime 推导。
- `runtime.ts` 的 `buildAutomationArgs` 已改用 `env.devtoolsHost === 'win32'` 推导 `hasWindowsBundle`，与该单源一致。

## 4. Validation & Error Matrix

- 无显式校验；`config` 容错（缺失/undefined → 视为 darwin）。
- `resolveDevtoolsLogRoot` 兜底报错改用语义化信息：`runtime=X devtoolsHost=Y`，便于定位不支持的环境。

## 5. Good / Base / Bad Cases

- Good：WSL（microsoft 串）= `{runtime:'linux', devtoolsHost:'win32', isWsl:true, needsBridge:true}`
- Good：WSL（WSL_DISTRO_NAME 辅助）= 同上
- Base：mac = `{runtime:'darwin', devtoolsHost:'darwin', isWsl:false, needsBridge:false}`
- Base：Windows = `{runtime:'win32', devtoolsHost:'win32', isWsl:false, needsBridge:false}`
- Bad：裸 linux（无 WSL 信号）= `{runtime:'linux', devtoolsHost:'win32', isWsl:false, needsBridge:false}` → 无可用 DevTools，依赖上层兜底报错

## 6. Tests Required

- `tests/platform.test.cjs`：
  - `detectWsl`：含 microsoft 版本串 → true；普通 linux + 注入 `wslDistroName:''` → false；注入 `wslDistroName` 辅助 → true；非 linux + 辅助信号 → false；缺省读真实 `/proc/version` 不抛异常
  - `detectDevtoolsHost`：`'win32'/'linux' → 'win32'`；`'darwin' → 'darwin'`
  - `resolveEnvironment`：Windows / macOS / 裸 linux / WSL(microsoft 串) / WSL(WSL_DISTRO_NAME 辅助) 五态，`runtime`/`readProcVersion`/`wslDistroName` 全注入

## 7. Wrong vs Correct

#### Wrong
```ts
// 用能否跑 wslpath 判定 WSL（精简镜像可能缺）
const isWsl = canRunWslpath()
```
#### Correct
```ts
// 用 /proc/version 含 microsoft（主信号）+ WSL_DISTRO_NAME（辅助信号）判定，更稳
const isWsl = detectRuntimeOS() === 'linux'
  && (/microsoft/i.test(readProcVersion()) || Boolean(process.env.WSL_DISTRO_NAME))
```
#### Wrong (旧)
```ts
// 用 cliPath 是否 .bat 判定 DevTools 宿主（Windows .exe 包裹会被误判为 mac）
const devtoolsHost = cliPath.toLowerCase().endsWith('.bat') ? 'win32' : 'darwin'
```
#### Correct
```ts
// 由 runtime 推导 DevTools 宿主
const devtoolsHost = runtime === 'linux' ? 'win32' : runtime
```

## 8. 不变清单（回归面隔离）

路径转换/镜像逻辑保持原样，识别层不重写：
- `toWindowsPath` / `mountedDriveMatch` / `isWslUncPath` / `runWindowsCommand`
- `resolveDevtoolsProjectPath` / `assertSupportedDevtoolsProjectPath`
- `isWslUncPath` 仍用于拒绝 UNC 路径（runtime.ts 调用点不变）
