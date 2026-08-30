# 完善 Agent 真实交互与等待体验

## Goal

让 Agent 在微信开发者工具中以接近真实用户的方式完成小程序交互，并通过跨原生、Taro、uni-app 的可观测状态进行等待，减少误报成功、固定等待和快照噪音。

## Requirements

- 修复 `await ref:@eN` 对已有元素错误超时的问题，并补充回归测试。
- `click` 对标准 checkbox / radio 优先触发其可点击 label，使“命令成功”与真实状态变化一致。
- 新增必要的真实交互命令：`back`、`scroll`、`swipe`、`longpress`。
- 手势优先使用开发者工具自动化协议提供的触摸/长按能力，不用脚本直接改业务状态冒充用户操作。
- 保留 `visible:`、`hidden:`、`route:` 等确定性等待；为无法预先知道 selector 的同页交互提供框架无关的“页面可观测变化”等待。
- 等待依据只使用编译后小程序共有的 route、页面栈和 WXML 可观测树，不依赖原生、Taro 或 uni-app 的源码实现。
- 不把固定 sleep 作为默认成功条件；超时必须保留真实条件和底层错误信息。
- 精简默认 snapshot 的文本与上下文噪音，同时保持默认 ASCII map 和 `@e` 可操作引用。
- 在 `demo/` 中同时扩展原生、Taro、uni-app 三个公开合成示例，覆盖滚动、滑动、长按、弹窗和临时状态；不得引用真实生产项目数据或路径。
- CLI、Codex skill、产品契约与测试保持同步。

## Acceptance Criteria

- [x] `await ref:@eN` 能在元素存在时通过、元素不存在时超时，并有直接覆盖循环依赖回归的测试。
- [x] 三个 Demo 中 checkbox / radio 的真实点击会更新选中状态，CLI 不再只返回假成功。
- [x] `back`、页面/容器 `scroll`、优先触摸的 `swipe`、`longpress` 均有 CLI 帮助、解析、执行与测试覆盖。
- [x] action 可用一个简洁条件等待未知的同页可观测变化；已知条件仍可显式等待 route/visible/hidden。
- [x] 默认 snapshot 不再把 navigator 全部后代文本拼成一个标签，也不为已有明确文本的按钮追加错误上下文。
- [x] 三个 Demo 均有 interaction 页面并可成功构建；公开 Demo 不含本机绝对路径、账号、AppID 或生产数据。
- [x] `npm run build`、相关测试、完整 `npm test` 通过；真实 Mac DevTools gate 单独执行并记录通过或明确的跳过原因。
- [x] README、`skills/miniprogram-browser/SKILL.md` 与 `.trellis/spec/cli/product-contracts.md` 描述一致，默认路径保持简单。

## Notes

- 不新增 `get visible` / `get enabled` 之类与 snapshot 和 `await` 重叠的查询命令。
- 当前 Mac DevTools 2.02.2608040 的 `native confirmModal/cancelModal` 返回空成功但不触发系统 modal 按钮，因此不新增会误报成功的专用 `dialog` L0 命令；公开 Demo 保留 modal 供后续上游兼容验证。
- 等待“页面发生变化”不等于永久保存瞬时证据；动作监听与短暂状态留存仍作为后续独立能力研究。
