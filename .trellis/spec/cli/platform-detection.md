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
  isWsl: boolean        // runtime=linux 且 /proc/version 含 microsoft
  needsBridge: boolean  // runtime=linux 且 devtoolsHost=win32
}

function detectRuntimeOS(): RuntimeOS
function detectWsl(versionText?: string): boolean
function detectDevtoolsHost(config: AnyRecord): DevtoolsHostOS
function resolveEnvironment(config: AnyRecord, options?: AnyRecord): Environment
```

## 3. Contracts

### 3.1 两维度模型（关键）

| 维度 | 来源 | 取值 |
|------|------|------|
| `runtime` | `process.platform` | win32 / darwin / linux |
| `devtoolsHost` | `cliPath` 是否 `.bat` 结尾 | win32（.bat）/ darwin（其他） |

- **WSL** = `runtime=linux` 且 `devtoolsHost=win32` → `needsBridge=true`，需路径翻译 + 受控镜像桥接。
- **裸 linux**（runtime=linux，devtoolsHost=darwin）→ 无 DevTools 可用，CLI 应在合适时机报「本环境不支持」。

### 3.2 WSL 判据（关键）

- 判据：`runtime==='linux'` 且 `/proc/version` 含 `microsoft`（不区分大小写）。
- 为什么不用「能跑 wslpath」：精简 WSL 镜像可能缺 `wslpath`，但 `/proc/version` 一定在。
- `versionText` 可注入（单测喂字符串，不依赖真实文件系统）；缺省读真实 `/proc/version`，读不到返回 `''` → `false`。
- 非 linux 宿主 `detectWsl` 直接返回 `false`，**不读** `/proc/version`。

### 3.3 DevTools Host 判据

- `cliPath` 以 `.bat` 结尾（不区分大小写）→ `win32`；否则 `darwin`。
- 这与 `runtime.ts` 原有 `hasWindowsBundle` 判据一致，可逐步替换为 `env.devtoolsHost`。

## 4. Validation & Error Matrix

- 无显式校验；`config` 容错（缺失/undefined → 视为 darwin）。
- `resolveDevtoolsLogRoot` 兜底报错改用语义化信息：`runtime=X devtoolsHost=Y`，便于定位不支持的环境。

## 5. Good / Base / Bad Cases

- Good：WSL = `{runtime:'linux', devtoolsHost:'win32', isWsl:true, needsBridge:true}`
- Base：mac = `{devtoolsHost:'darwin', isWsl:false, needsBridge:false}`（runtime 取决于真实宿主）
- Bad：裸 linux + mac DevTools = `{runtime:'linux', devtoolsHost:'darwin', isWsl:false, needsBridge:false}` → 无可用 DevTools，依赖上层兜底报错

## 6. Tests Required

- `tests/platform.test.cjs`：
  - `detectWsl`：含 microsoft 版本串 → true；普通 linux → false；注入文本路径不抛异常
  - `detectDevtoolsHost`：`.bat` → win32；其他/缺失/undefined → darwin
  - `resolveEnvironment`：WSL = linux+win32+needsBridge；mac DevTools → darwin+非桥接；Windows DevTools → win32+非 WSL
  - 注：`runtime` 维度不可注入（来自 `process.platform`），mac/win 用例只断言可注入维度

## 7. Wrong vs Correct

#### Wrong
```ts
// 用能否跑 wslpath 判定 WSL（精简镜像可能缺）
const isWsl = canRunWslpath()
```
#### Correct
```ts
// 用 /proc/version 含 microsoft 判定，更稳
const isWsl = detectRuntimeOS() === 'linux' && /microsoft/i.test(readProcVersion())
```

## 8. 不变清单（回归面隔离）

路径转换/镜像逻辑保持原样，识别层不重写：
- `toWindowsPath` / `mountedDriveMatch` / `isWslUncPath` / `runWindowsCommand`
- `resolveDevtoolsProjectPath` / `assertSupportedDevtoolsProjectPath`
- `isWslUncPath` 仍用于拒绝 UNC 路径（runtime.ts 调用点不变）
