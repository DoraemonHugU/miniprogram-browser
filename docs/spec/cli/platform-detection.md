# CLI 平台识别契约（code-spec）

> 适用范围：`src/lib/platform.ts` 的平台 / 环境识别层。
> 维护者：改动 `platform.ts` 或 `runtime.ts` 中引用 `resolveEnvironment` 的分支时，必须同步本文件。

## 1. Scope / Trigger

- 触发：WSL / Windows / macOS 三环境的识别是跨层契约（CLI 运行宿主 → DevTools 安装宿主 → 路径转换策略）。
- 背景（已确立事实）：原 `runtime.ts` 无 `isWsl()`，WSL 靠三处散落信号间接猜：`/mnt/<drive>/` 前缀、`\\wsl$\` UNC 正则、能否跑 `wslpath`。识别与路径转换耦合，无「环境」一等概念。
- 本契约把识别收敛为单一 `Environment` 模型；路径转换消费该模型，不负责复制或镜像工程。

## 2. Signatures

```ts
// src/lib/platform.ts
type RuntimeOS = 'win32' | 'darwin' | 'linux'        // CLI 进程所在 OS（process.platform）
type DevtoolsHostOS = 'win32' | 'darwin'             // DevTools 只装 win/mac
interface Environment {
  runtime: RuntimeOS
  devtoolsHost: DevtoolsHostOS
  isWsl: boolean        // runtime=linux 且（/proc/version 含 microsoft 或 WSL_DISTRO_NAME 非空）
  needsBridge: boolean  // isWsl（WSL 需要跨系统路径转换，不创建镜像）
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

- **WSL** = `runtime=linux` 且存在 WSL 信号 → `needsBridge=true`，需路径翻译；不复制项目或创建受控镜像。
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
- `runtime-cli.ts` 的 `buildAutomationArgs` 使用 `usesWindowsDevtoolsBundle(env)`：仅 Windows 本机或真实 WSL 使用 Windows 入口，裸 Linux 不因 `devtoolsHost=win32` 就做路径转换。

### 3.4 Windows CLI 入口选择

- 平台判断不依赖 CLI 文件名；确认 Windows / WSL 之后，再按安装目录的实际文件选择入口。
- 传入目录时优先 `cli.bat`；仅在缺少 `cli.bat` 时回退到 `cli.js`。不额外调用 CLI 解析版本号。
- `cli.bat` 由 `cmd.exe /d /c` 执行，不需要同目录 `node.exe`。
- 批处理入口相对安装目录调用（`cwd` 指向安装目录），避免安装目录与项目路径同时含空格时被 `cmd /c` 截断；参数保持独立传入，不由用户拼接引号。
- 显式 `cli.js` 属于旧布局兼容路径，必须与同版本 `node.exe` 配套；不完整时直接报错。

## 4. Validation & Error Matrix

- 平台默认取真实 `process.platform`，不因 `config` 缺失就假定为 macOS；测试通过参数注入平台与 WSL 信号。
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
- `tests/runtime.test.cjs`：目录入口优先 `cli.bat`；新布局不需要 `node.exe`；旧 `cli.js + node.exe` 仍按配套入口执行。
- `tests/cli-behavior.test.cjs`：通过真实子进程验证 `open/auto/close` 完整保留空格和中文项目路径；Windows CI 实际执行 `cmd.exe → cli.bat`，开发者工具本身使用测试替身。

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

## 8. 路径转换边界

- `runtime-windows.ts` 的 `toWindowsPath` 将 WSL 绝对路径交给系统 `wslpath -w`，不写死 automount root。
- `runtime-cli.ts` 的 `resolveDevtoolsProjectPath` 优先使用显式 DevTools 路径，其次按配置做前缀映射，再转换 WSL 路径；不复制或镜像工程。
- `isWslUncPath` 用于选择启动及关闭策略，不表示所有 UNC 路径都被 CLI 拒绝。DevTools 无法消费 UNC 时，使用 Windows 盘项目或显式路径映射。
