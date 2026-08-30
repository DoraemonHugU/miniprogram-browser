# 用户体验验证摘要

## 已复现问题

- `await ref:@eN` 对当前 snapshot 中存在的元素仍会超时，而 legacy `wait @eN` 能通过。
- checkbox / radio 的元素 tap 返回成功但 checked 状态不变；点击外层 label 才会产生真实状态变化。
- navigator 文本会把多个后代文本无分隔拼接，按钮会被追加无关 section 文本，增加 Agent 上下文噪音。
- `native navigateLeft` 可能返回成功但 route 不变，因此不能只信调用返回值。
- 页面滚动目前需要 eval，新用户无法从主命令完成；swiper、longpress、modal 也缺少标准命令。

## 体验结论

- 不增加 `get visible` / `get enabled` 等重叠查询；默认 snapshot 已承担发现状态，`await` 承担等待状态。
- Agent 最需要的是“动作是否真的产生了可见结果”，而不是更多底层字段。
- 确定结果优先精确等待；结果 selector 不确定时，需要基于编译后 WXML 的变化等待，而不是猜测框架生命周期。
- 临时 toast 的长期留存属于动作证据能力，不应把复杂监听偷偷塞进基础等待。
