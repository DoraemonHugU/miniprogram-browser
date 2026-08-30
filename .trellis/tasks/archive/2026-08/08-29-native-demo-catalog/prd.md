# 原生公开 Demo 组件目录

## Goal

把 `demo/public-demo` 扩展为标准原生微信小程序格式的公开调试目录，为 CLI 的页面发现、ref、表单、重复节点和导航能力提供可重复的合成测试目标。

## Requirements

### R1. 安全与公开性

- 只使用人工合成数据和 `touristappid`，不得包含真实项目的 AppID、路径、文案、截图、日志、接口或运行数据。
- Demo 不发网络请求，不读取本机敏感数据，不依赖登录用户或后端。

### R2. 标准原生目录

- 使用微信原生小程序的 `app.json`、页面 `.js/.json/.wxml/.wxss` 四文件结构，不引入框架、构建器、自定义组件或第三方依赖。
- 保留 `demo/public-demo` 作为原生基线。

### R3. 最小组件目录

- `pages/index/index` 是目录首页，明确列出并可跳转到各测试页。
- `pages/controls/index` 覆盖 input、button、switch、checkbox、radio 及可观察状态。
- `pages/lists/index` 覆盖重复同类节点、选择状态和动态列表变化。
- `pages/navigation/index` 覆盖进入详情页；`pages/detail/index` 提供目标页和返回行为。
- 所有控件使用稳定、清晰的合成文案，页面变化后能通过 `snapshot/get/path/page-stack` 观察。

### R4. CLI 调试基线

- 同一 Demo 必须支持 `open -> app inspect -> snapshot -> fill/click/get -> navigate -> page-stack/path -> screenshot -> close`。
- Demo 只暴露标准小程序行为；不得为 CLI 添加框架识别或 Demo 专用分支。
- 对目录、路由和关键交互补自动化回归测试，避免未来页面结构变更静默破坏真实 gate。
- 普通同页点击成功时不得输出猜测性的登录/授权弹窗提示；导航要求由显式 await 验证。
- 重复 selector、重复文案控件的 ref 必须命中 snapshot 对应 occurrence，不能被同标签 id 控件挤占索引。

## Acceptance Criteria

- [x] `app.json` 注册目录、Controls、Lists、Navigation、Detail 五个标准页面，且每页四文件齐全、JSON 可解析。
- [x] 首页可通过标准 `wx.navigateTo` 到达三个目录页面。
- [x] Controls 页的输入、按钮、switch、checkbox、radio 状态均可观察。
- [x] Lists 页含重复同类按钮，并可新增、选择和删除合成列表项。
- [x] Navigation 页可进入 Detail，Detail 可通过标准返回行为回到上一页。
- [x] 普通同页点击无猜测性 notice；重复控件后一个 ref 经单测和 Mac 真机验证准确命中。
- [x] 静态 Demo 契约测试与现有全量测试通过。
- [x] macOS 真实公开 Demo 链路覆盖表单、列表和导航并完成截图与关闭。
- [x] Git diff、敏感信息扫描和 npm pack 清单不含生产信息或运行产物。

## Out of Scope

- 本任务不实现 Taro 或 uni-app Demo；它们在原生行为契约稳定后复用同一旅程。
- 不增加 Overlay、异步异常、滚动控制等第二阶段场景。
- 不修改 CLI 命令面，不提交、推送或发布。
