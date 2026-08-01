# 实施计划

## 阶段 1：基础环境

- [x] 1.1 安装 ESLint + typescript-eslint
- [x] 1.2 创建 `eslint.config.mjs`，配置 flat config
- [x] 1.3 添加 `npm run lint` + `npm run lint:fix` 脚本
- [x] 1.4 验证 lint 通过（初始状态下允许现有代码存在 errors，但关闭 no-unused-vars 等不相关规则）

## 阶段 2：类型声明

- [ ] 2.1 创建 `src/types/` 目录
- [ ] 2.2 创建 `src/types/miniprogram-automator.d.ts` — 外部库声明
- [ ] 2.3 创建 `src/types/core.ts` — SessionState / CliConfig 接口
- [ ] 2.4 创建 `src/types/index.ts` — 统一导出

## 阶段 3：逐文件修复 (856 errors)

按风险从低到高：

| 轮次 | 文件 | errors | 验证 |
|------|------|--------|------|
| 3.1 | runtime-core.ts / runtime-cli-shared.ts / runtime-windows.ts | ~27 | lint + build + test |
| 3.2 | runtime-state.ts / runtime-bridge.ts / runtime-timeline.ts | ~40 | lint + build + test |
| 3.3 | runtime-logs.ts / runtime-resolve.ts / runtime-cli.ts | ~26 | lint + build + test |
| 3.4 | core.ts / cli-io.ts / cli-payload.ts / cli-help.ts | ~55 | lint + build + test |
| 3.5 | runtime-wait.ts / runtime-connect.ts | ~67 | lint + build + test |
| 3.6 | runtime-snapshot.ts | ~81 | lint + build + test |
| 3.7 | app-inspect.ts / visual-change.ts | ~54 | lint + build + test |
| 3.8 | session-store.ts / visual.ts | ~292 | lint + build + test |
| 3.9 | miniprogram-browser.ts | ~203 | lint + build + test |

每个文件修复模式：
1. 给所有无类型参数补正式类型
2. 使用核心接口（SessionState / CliConfig / MiniProgram）
3. 局部 options 参数用 `Record<string, unknown>` + 类型守卫
4. 禁止使用 `any`

## 阶段 4：启用 strict

- [ ] 4.1 `tsconfig.json` 设置 `strict: true`
- [ ] 4.2 修复剩余的 strict-null-checks / strict-function-types errors

## 验证清单

每轮：
```bash
npm run build && npm run test:node
npm run lint
```
