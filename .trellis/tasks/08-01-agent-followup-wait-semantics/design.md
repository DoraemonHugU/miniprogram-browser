# 产品/技术设计

首选增加一个可选布尔开关（暂定 `--follow`，最终名称以实现前契约评审为准）：命令完成后等待已有条件，再返回当前 route 和新的 Snapshot 摘要。默认不跟随，避免 Agent 上下文膨胀。

等待语义分为：

- `--await <condition>`：业务条件，例如 route、visible、app-ready；
- `--timeout <ms>`：条件最长等待时间；
- 内部 settle wait：动作后给 DevTools 一小段稳定时间，默认值应可观察且不伪装成业务等待。

如果条件未满足，错误必须保留当前 route、条件和 timeout，不能只返回“操作成功”。
