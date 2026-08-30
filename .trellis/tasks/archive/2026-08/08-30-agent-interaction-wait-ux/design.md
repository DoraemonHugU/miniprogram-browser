# 设计：真实交互与框架无关等待

## 1. 设计边界

本次只补齐 Agent 调试小程序的必要交互闭环，不引入后台 watcher、框架适配层、任意脚本执行别名或新的状态数据库。所有能力都落在微信开发者工具自动化端已经暴露的 page、element、native API 上。

## 2. 等待模型

等待分为两类：

1. 已知业务结果：继续使用 `route:`、`route-change`、`visible:`、`hidden:`、`ref:` 等明确条件。
2. 未知同页结果：action 执行前采集 route、页面栈和语义 WXML 的轻量签名，执行后等待签名首次发生变化。对外条件名使用 `change`。

`change` 只在有 action 前态的调用中成立；独立 `await change` 没有可靠基线，应给出明确错误。它不依赖 React/Vue/原生源码，只观察编译后运行时。动态页面可能持续变化，因此稳定窗口有上限，变化一旦确认即可返回，不把“永远静止”作为成功要求。

`stable` 仍表示 runtime route/page-stack 安静且视图可读取，不承诺业务数据已经满足。默认 action 不自动增加隐藏的秒级等待；Agent 在已知结果时指定精确条件，在未知结果时使用 `--await change`。

## 3. 真实交互

- checkbox / radio：解析 `@e` 后查找包含控件的最小 label，并对 label 执行 tap；找不到 label 时保留原元素 tap。这样兼容微信标准组件，也不阻断自定义控件。
- `back`：先尝试 native 返回手势并验证 route/page-stack；若协议返回成功但状态未变，则直接调用小程序 `navigateBack` 运行时方法，避开 SDK 内置的固定 3 秒等待，并继续验证 route。
- `scroll`：页面使用 `page.scrollTop()` + `miniProgram.pageScrollTo()`；scroll-view 使用元素属性 + `element.scrollTo()`。
- `swipe`：根据元素几何中心计算起止点，优先调用 `touchstart`、若干 `touchmove`、`touchend`；当前 DevTools 不会让该序列驱动原生 `swiper` 的组件默认行为，因此在索引未变化时回退到 automator 官方的 `swipeTo()` 组件动作，仍不使用 `eval/setData`。
- `longpress`：调用 element 的 longpress 协议。

所有 action 复用统一的 target 解析、runtime lock、可选 await 和 `--follow` 输出路径。

## 4. Snapshot 降噪

- interactive 节点优先使用直接可见标签，不把全部后代文字无分隔拼接。
- 已有清晰业务文案的按钮不再自动追加 section 文本；重复项由稳定业务键和兄弟顺序区分，不扩大默认标签。
- 父子节点可确定时，删除已由可操作父节点表达的重复纯文本；不使用 Demo 专属关键词过滤。
- 保持 `@e` 的确定性：同一 route、同一语义 key、同一兄弟顺序产生相同编号；本次不引入跨页面持久 ID。

## 5. Demo 与验证

在 `demo/public-demo`、`demo/taro-demo`、`demo/uni-app-demo` 增加相同语义的 interaction 页面：页面滚动、scroll-view、swiper、longpress、modal、短暂 inline 状态。构建产物继续进入各自现有输出目录。

测试分层：

- 单元：condition parser/执行、目标解析、手势坐标、snapshot 文本与命令解析。
- Demo 静态：三个框架路由、源码与编译产物一致，无真实数据。
- CLI 集成：help/JSON/action dispatch 和错误边界。
- 真实 Mac gate：公开 Demo 中执行 open、snapshot、checkbox/radio、scroll、swipe、longpress、back，核对实际页面状态；modal 单独记录 DevTools native 协议限制。

## 6. 兼容与失败语义

新增命令不改变已有 `click`、`goto`、`await` 默认行为。底层不支持某个 native/touch 方法时，返回原始错误及当前命令上下文；除 `back` 的明确 runtime fallback 外，不静默改用 `eval` 修改状态。
