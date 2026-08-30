# Design：原生公开 Demo 组件目录

## 1. 边界

- Demo 是 CLI 的公开测试目标，不是完整组件库。
- 页面使用微信原生 API 和标准四文件结构；没有共享组件层、构建步骤或第三方包。
- `demo/public-demo` 继续作为原生基线，后续 Taro/uni-app 只复刻行为契约，不共享框架源码。

## 2. 页面与行为契约

| 页面 | 目的 | 关键行为 |
|------|------|----------|
| Index | 页面发现与目录导航 | 三个 `navigateTo` 入口 |
| Controls | 表单和状态读取 | input、click、switch、checkbox、radio |
| Lists | 重复 selector 与动态结构 | add、select、remove，至少两个同类按钮 |
| Navigation | 路由和页面栈 | `navigateTo` Detail |
| Detail | 目标页和回退 | 参数展示、`navigateBack` |

关键状态同时以页面文本呈现，方便 `snapshot/get text`，不要求 Agent 执行任意 `eval` 才能判断结果。

## 3. CLI 边界

- CLI 仅把 Demo 识别为 `project.config.json -> miniprogramRoot -> app.json` 的标准微信项目。
- 真实 gate 使用页面当前输出的 `@e`，不得硬编码长期 ref 编号。
- 点击导致页面结构或路由变化后重新 snapshot，遵守现有 `@e` 生命周期。

## 4. 安全

- `touristappid`、合成英文文案、无网络、无 storage、无外部资源。
- 真机截图只落系统临时目录，验收后移入废纸篓；不写入仓库。

## 5. 真机旅程暴露的 CLI 修复

- 普通同页点击成功时不输出“可能登录/授权弹窗”的猜测性 notice；导航目标由显式 await 验证。
- 重复 selector、重复文案控件按派生 selector 与 occurrence 精确重解析，不能默认命中第一个元素，也不能被同标签 id 控件挤占索引。
