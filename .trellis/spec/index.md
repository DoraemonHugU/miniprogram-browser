# Code-Spec Index

> 代码契约（可执行规格）索引。每个文件记录具体签名 / 响应字段 / 边界行为，供实现与测试使用。
> 思考类清单见 `guides/index.md`。

## CLI 层

| Spec | 范围 |
|------|------|
| [cli/screenshot-contracts.md](./cli/screenshot-contracts.md) | screenshot / snapshot 的视觉与结构输出通道、稳定性映射、默认模式、snapshot 隐蔽真实像素副作用 |
| [cli/platform-detection.md](./cli/platform-detection.md) | 平台识别层：两维度模型、WSL 判据（/proc/version 含 microsoft）、Environment 契约、回归隔离清单 |
