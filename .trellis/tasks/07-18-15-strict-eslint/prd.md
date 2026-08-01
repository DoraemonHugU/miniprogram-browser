# TS strict 模式 + ESLint 门禁 + 类型接口重构

## Goal

将 miniprogram-browser 代码库从 `strict: false` + 隐式 any 推进到安全可维护的状态：
- `tsc --strict` 零 error
- ESLint 禁止 any 扩散
- 核心类型接口定义（`SessionState` / `CliConfig` / `MiniProgram`）
- 每步有测试护航

## Requirements

1. **ESLint 门禁先行**：新代码不能引入新的 `any`，不能使用 `no-explicit-any` 技巧
2. **类型接口定义**：为 `state`、`config`、`miniProgram` 等核心参数定义正式接口
3. **strict errors 逐文件修复**：TS7006/TS7031/TS2683 共 856 errors 分批次推进
4. **增量迁移**：不阻塞当前功能开发，旧代码改到哪修到哪
5. **测试护航**：每批修复后 `npm run build && npm run test:node` 必须全绿
6. **不允许 `// @ts-ignore` 或 `// @ts-expect-error`** 作为 strict 修复手段
7. **Layer 3 门禁**：`@typescript-eslint/no-unsafe-*` 确保任何漏网的 `any` 不能渗透到业务代码

## Non-Goals / Out of Scope

- 不改动运行时行为 / 业务逻辑
- 不重构函数拆分或文件结构
- 不处理 `noUnusedLocals` / `noUnusedParameters`（属于后续优化）
- 不处理 `strictNullChecks` 相关的 TS2322 errors（不在此 task 范围内）

## Acceptance Criteria

- [x] `npm run lint` 存在且通过（ESLint 配置就绪）
- [x] `no-explicit-any` 规则为 error，新代码引入 `any` 会被 CI 阻止
- [x] `no-unsafe-*` 规则为 error，any 不能渗透到业务代码
- [x] `src/types/` 目录存在，包含 `miniprogram-automator.d.ts` 和 `core.ts`
- [ ] 核心接口 `SessionState`, `CliConfig`, `MiniProgram` 定义完成
- [ ] 所有 TS7006/TS7031/TS2683 errors 清零（856 → 0）
- [ ] `tsc --strict` 报错数 < 200（覆盖核心接口后剩的属于非核心模块，可按需推进）
- [ ] `npm test` 全绿
