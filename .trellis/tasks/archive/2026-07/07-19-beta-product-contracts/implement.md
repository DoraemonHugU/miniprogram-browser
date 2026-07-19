# Implement：Beta 产品契约（范围 A）

## Checklist

1. [ ] 写 `.trellis/spec/cli/product-contracts.md`（7 段 code-spec 深度）
2. [ ] 更新 `skills/miniprogram-browser/SKILL.md`：`@e` 硬规则 + 稳定面
3. [ ] （可选）`AGENTS.md` 一行指针到 product-contracts
4. [ ] 收敛 `prd.md` acceptance 勾选

## Validate

- 人工通读 skill：agent 能否只靠 skill 遵守 `@e` 协议
- 无 `src/**` 行为 diff

## Rollback

删除/还原上述 md 文件即可
