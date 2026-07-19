# PRD：Beta 产品契约冻结

## Goal

把 beta 阶段已定稿的产品边界写成可验收契约，消除 agent/人对 **CLI 公共面** 与 **`@e` 生命周期** 的错误预期；明确非目标与交付缺口，避免继续发散功能。

## User value

- Agent/人知道：哪些命令是稳定主路径、哪些是逃逸
- 知道 `@eN` 何时可用、何时必须重 snap
- 团队知道：下一步是交付闭合，不是再开大重构

## Scope decision

**交付范围 = A（已确认）**

- 契约文档（`.trellis/spec/cli/`）+ `skills/miniprogram-browser/SKILL.md` 补强
- **不**改核心运行时行为
- **不**在本任务内解决 GitHub push 403 / 远程 PR
- **不**重做 `@e` 永久 ID、不扩 CLI 命令面、不再设计 ASCII

## Confirmed facts

### 对外形态

- npm 主入口是 CLI：`bin.miniprogram-browser` → `dist/`；`dist/lib/*` **不是** 稳定 SDK。
- 命令已分层（help）：L0 核心 / L1 诊断 / L2 逃逸。
- 产品原则：脏活内收；成功回显必要信息（含 autoPort、session、path、mode）；失败人话 + 底层 raw（不强制 code/next）。

### `@e` 机制

- 分配：`@e${index}`；跨 snapshot 尽力用 `stableKey` 复用同号。
- 解析：stableKey → strategy → selector+index；route/signature 校验；失效提示重 snap。
- 存储在 **session** 状态内；跨 session 不共享。

### Skill 缺口（本任务要补）

- 已有「页面变化后重新 snapshot」等软提示。
- 缺硬规则：非永久 ID、跨路由/session 无效、stale 禁止重试旧号、先 snap 后用本轮 `@e`。

## Requirements

| ID | 要求 |
|----|------|
| R1 | 新增 code-spec：CLI 稳定面（L0/L1/L2）、成功/失败输出最低约定、非公共 SDK |
| R2 | 同一 spec 或关联章节：`@e` 生命周期与使用协议（≥4 条硬规则） |
| R3 | `SKILL.md` 增加可执行的 `@e` 协议与「稳定面」指针（agent 默认可读） |
| R4 | 契约写明 ASCII：数字=N、文案在树、不承担完整 UI 文案 |
| R5 | 交付缺口仅作清单备注（push/PR、真机门禁），不纳入本任务执行 |

## Acceptance Criteria

- [x] `.trellis/spec/cli/product-contracts.md`（或等价路径）存在且含 L0/L1/L2、`@e` 规则、非目标
- [x] `SKILL.md` 含至少 4 条 `@e` 硬规则，且指向/复述稳定 CLI 面
- [x] 不修改 `src/**` 运行时逻辑（纯文档/skill）
- [x] `prd.md` 无未决 Open questions

## Out of scope

- 重做 `@e` 永久 ID / 全局 UUID
- 批量新 CLI 命令
- ASCII 算法再改
- Git 远程权限与 push/PR 操作
- 成功 JSON 字段强制 schema 的代码校验（文档约定即可；代码 enforcement 另任务）

## Background / decisions locked

- API 暴露合理：公共面 = CLI，不是 lib SDK。
- `@e` = session 内、snapshot 作用域的可重绑句柄；尽力 stableKey 复用，不保证永久同号。
- 下一步产品杠杆 = 交付与验收，不是新功能。
