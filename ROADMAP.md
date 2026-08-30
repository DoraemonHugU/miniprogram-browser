# Roadmap

`miniprogram-browser` 的方向不是堆叠命令，而是让 Agent 用最短、可验证的操作链调试微信小程序。路线按用户结果组织；`Next` / `Later` 是探索方向，不是版本或日期承诺。

## 产品原则

- CLI 吸收路径、信任、端口、runtime 复用等脏活，用户只表达调试目标。
- 页面是否就绪由路由、元素、页面栈和运行态探针判断；固定毫秒只保留为显式逃逸点或协议退避。
- 微信原生、Taro、uni-app 最终都按标准微信小程序产物工作，CLI 不增加框架专用分支。
- 默认产物写入系统临时目录；公开文档、测试和截图只使用仓库内合成 Demo。
- 新能力先证明能提升 Agent 调试效果，再决定公共命令和长期兼容面。

## Now：可靠完成一次小程序调试闭环

**结果**：让 Agent 在 macOS、Windows 和 WSL 上从项目目录直接建立会话，观察页面、执行动作并用可观察状态确认结果。

当前重点：

- `open/connect` 复用同项目 live runtime，无法唯一选择时要求显式 session。
- automation 启用后立即探测端口，未就绪才轮询；`doctor` 轮询 Tool/App 状态并在就绪后立即返回。
- action 不默认插入固定 sleep；已知结果使用路由/元素条件，未知同页结果使用框架无关的 `--await change`。
- `back`、页面/容器滚动、滑动和长按已进入主路径；不使用 `eval/setData` 冒充交互结果。
- `snapshot` 默认提供紧凑语义树与 ASCII 空间图；精确坐标和真实截图按需开启。
- 原生、Taro、uni-app 三套合成 Demo 提供同构六页和统一交互回归旅程。

验收信号：

- 默认路径不要求用户选择端口或手工转换项目路径。
- 已就绪 runtime 不因固定等待额外停顿。
- 行为变化都有回归测试；真实 DevTools 验证只使用合成 Demo。

## Next：扩充可复现的交互场景

**结果**：让维护者能在三套 Demo 中复现相同的组件、列表变化、页面跳转和短暂反馈，从而验证 CLI 的框架中立性。

候选工作：

- 在现有组件库式 Catalog 上继续补充尚未覆盖的加载态、原生 Toast 和复杂嵌套滚动。
- 验证系统 modal 的可靠控制；当前 Mac DevTools 2.02.2608040 中 `native confirmModal/cancelModal` 会返回空成功但不触发按钮，修复前不冻结专用 L0 命令。
- 三套 Demo 保持相同的路由、测试标识和预期结果，不复制真实业务 UI 或数据。
- 把新暴露的跨平台、重复元素和瞬时交互问题先写成失败测试，再修 CLI。

验收信号：

- 同一条 CLI 旅程可运行于三套编译后的标准微信小程序产物。
- Demo 只含合成数据与游客 AppID，可安全提交到公开仓库。
- 每个新增交互场景至少有一条自动化回归或明确的真实 DevTools gate。

## Research Candidate：动作级瞬时变化证据

**想解决的问题**：点击后出现很短时间的 Toast、loading 或中间态时，动作前后各做一次 snapshot 可能都看不到，Agent 因而缺少判断依据。

已有实现给出的启发：

- Agent Browser 的主循环仍是“snapshot → action → 页面变化后重新 snapshot”，并优先使用元素、文本、URL、load state 或 JS 条件等待；它还提供显式 `trace start/stop` 和录屏能力。
- Playwright Trace Viewer 为每个动作保存 Before / Action / After DOM snapshot；开启 screenshots 时还会录制 screencast filmstrip，用于查看动作期间的中间视觉帧。
- 当前依赖 `miniprogram-automator@0.12.1` 提供单次 screenshot、selector/function/time wait、console 和 exception 事件，但没有公开的 WXML mutation 或连续 screencast 事件。因此，小程序侧若要保留短暂变化，可能需要在**显式动作观察窗口**内做有界采样，而不能假设存在浏览器级事件流。

建议先做技术验证，不直接冻结命令形态：

1. 只在用户显式开启动作证据时工作，不启动 session 级后台 watcher。
2. 动作前保存基线；动作后在一个短、有界窗口内采样语义签名、路由和已有 console/exception/timeline 事件。
3. 只保留发生变化的帧并按签名去重；页面稳定后立即停止。
4. 真实像素只按需采样，避免把每次操作都变成昂贵截图。
5. 默认写系统临时目录；动作结果直接返回证据目录，不增加 `artifacts list/prune` 一类管理命令。
6. 最小索引只描述动作、路由、变化顺序和文件路径，不加入字节大小、耗时等业务无关噪音。

技术验证的通过标准：

- 合成 Demo 中一个持续约 1 秒的 Toast 至少留下一个可读的变化帧。
- 未开启该能力时，普通动作不增加 snapshot 或 screenshot 开销。
- 相同状态不会重复落盘；默认目录不位于小程序工程内。
- 证据可由 Agent 直接读取，并且不包含真实生产项目、账号、AppID、路径或业务截图。

研究参考：

- [Agent Browser core loop](https://github.com/vercel-labs/agent-browser/blob/main/skill-data/core/SKILL.md)
- [Agent Browser command reference](https://github.com/vercel-labs/agent-browser/blob/main/skill-data/core/references/commands.md)
- [Playwright Trace Viewer](https://playwright.dev/docs/trace-viewer)
- [miniprogram-automator package](https://www.npmjs.com/package/miniprogram-automator)

## Later：把变化证据变成可消费的调试上下文

**结果**：让 Agent 在动作失败或状态不明确时读取一段紧凑的变化时间线，而不必重跑操作碰运气。

只有 Research Candidate 验证有效后才考虑：

- 语义变化摘要与按需视觉 diff。
- 将 route、console、exception 与变化帧按动作关联。
- 失败时保留证据、成功时按策略精简，仍不引入常驻清理守护进程。

## 明确不做

- 不把真实生产小程序当公开示例、截图或测试夹具。
- 不为 Taro 或 uni-app 添加框架专用 CLI 行为。
- 不用后台 watcher 替代动作级观察，也不默认持续录屏。
- 不把固定 sleep 重新包装成“智能等待”。
- 不在研究阶段承诺稳定 trace 命令、索引 schema 或发布日期。
