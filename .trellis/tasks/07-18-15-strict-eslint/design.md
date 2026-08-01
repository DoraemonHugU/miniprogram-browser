# TypeScript Strict 模式 + ESLint 门禁 — 技术设计

## 问题

目前 `tsconfig.json` 中 `strict: false`，导致 856 个 TS7006/TS7031/TS2683 errors（参数隐式 any）。LSP 提示的 `Parameter implicitly has an 'any' type` 遍布全库。无 ESLint 门禁，新代码可以继续引入 `any`。

## 设计方案

### 1. 层级门禁策略

```
┌────────────────────────────────────────────┐
│ Layer 1: tsc --noEmit              (CI)    │ ← TS 编译器
│         禁止不写类型                        │
├────────────────────────────────────────────┤
│ Layer 2: ESLint no-explicit-any     (error)│ ← lint 门禁
│         禁止出现 `any` 关键字               │
├────────────────────────────────────────────┤
│ Layer 3: ESLint no-unsafe-*         (error)│
│         any 不能渗透到业务代码              │
└────────────────────────────────────────────┘
```

Layer 3 (`no-unsafe-*`) 是真正的防线——IO 边界（`JSON.parse`、第三方库返回值）可能产生 unknown，但 `no-unsafe-*` 确保这些值不能直接调用/访问/传参，必须经过类型守卫。

### 2. unknown 的使用边界

`unknown` 只应在以下场景使用：
- IO 边界（`JSON.parse`、文件读取、环境变量）
- 第三方无类型库的原始返回值
- 上游 API payload 在类型守卫前的暂存态

一旦通过类型守卫确认了形状，就转换为正式接口。

### 3. 核心接口定义

#### SessionState
```typescript
interface SessionState {
  config: CliConfig
  sessionName: string
  route: string
  runtimeLaunchId: string | null
  portResolution: PortResolution | null
  refs: RefRecord[]
  nextRefIndex: number
  stableKeyToRef: Record<string, string>
  consoleEvents: RuntimeEvent[]
  exceptionEvents: RuntimeEvent[]
  routeEvents: RouteEvent[]
  runtimeAttached: boolean
  runtimeOwnerSession: string | null
  runtimeAttachedAt: number | null
  // ... etc
}
```

#### CliConfig
```typescript
interface CliConfig {
  projectPath: string
  autoPort: string
  devtoolsPort?: string
  cliPath?: string
  sessionDir: string
  screenshotDir: string
  tempScreenshotDir: string
  // ... etc
}
```

#### MiniProgram（外部库声明）
写入 `src/types/miniprogram-automator.d.ts`。

### 4. 增量迁移路径

不分新的 PR 分支——就地在 `main` 分支上推进，每批文件修完立即 `npm run build && npm run test:node` 验证。

优先级：按文件风险从低到高，先修纯工具函数后修入口文件。

### 5. ESLint 配置

使用 `typescript-eslint` v8 的 flat config（`eslint.config.mjs`），规则集：
- `@typescript-eslint/no-explicit-any: error`
- `@typescript-eslint/no-unsafe-argument: error`
- `@typescript-eslint/no-unsafe-assignment: error`
- `@typescript-eslint/no-unsafe-call: error`
- `@typescript-eslint/no-unsafe-member-access: error`
- `@typescript-eslint/no-unsafe-return: error`
- `@typescript-eslint/no-unsafe-unary-minus: error`

`no-explicit-any` 阻止写 `any`，但 `Record<string, any>` 等变通写法也被覆盖。`no-unsafe-*` 确保即使 `any` 出现（比如第三方库内部），也不让它们渗透到业务代码。

### 6. 禁用规则

- 不允许 `// @ts-ignore` / `// @ts-expect-error` 逃逸（由 `@typescript-eslint/ban-ts-comment` 控制）
- 不允许用 `as any` 强转
