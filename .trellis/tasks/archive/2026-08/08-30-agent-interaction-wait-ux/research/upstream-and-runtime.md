# 上游与运行时能力摘要

## 微信开发者工具自动化能力

当前依赖已提供：

- MiniProgram：`navigateBack`、`pageScrollTo`、`currentPage`、`pageStack`。
- Page：`scrollTop`、`waitFor`、`$` / `$$`、`wxml`。
- Element：`tap`、`longpress`、`touchstart`、`touchmove`、`touchend`、`scrollTo`、`offset`、`size`、`property`。
- Native：返回手势相关调用；类型层还暴露 modal 确认/取消，但当前 Mac DevTools 实测返回空成功且不触发弹窗按钮。

除系统 modal 控制外，这些能力足以实现本轮必要命令，无需增加第三方运行时依赖。原生 `swiper` 的 touch 序列不会触发组件默认切换，需回退到 automator 提供的 `swipeTo(index)`；该方法同样作用于标准编译产物，不需要框架分支。

## Mac 真实协议结论

- 环境：微信开发者工具 Stable 2.02.2608040，公开 `demo/public-demo`。
- `Tool.native` 的 `confirmModal` / `cancelModal` 返回空对象，但 modal 仍保持打开，页面回调不执行。
- Computer Use 只用于核对公开 Demo UI：modal 确实存在，真实点击“确定”后页面更新为 `Status: Modal accepted`，因此 Demo 本身无误。
- DevTools bundle 中仍声明 `wx.showModal.confirm` / `wx.showModal.cancel` 的 native target；当前运行结果表明不能把声明能力当作可靠 L0 契约。

## Agent Browser 可借鉴边界

可借鉴的是面向 Agent 的短命令、真实输入优先和动作后明确等待；不能照搬 DOM network-idle、浏览器 history 或 Playwright locator。小程序跨框架的共同层是编译后 route/page-stack/WXML，因此等待和目标解析应停留在这一层。

## 依赖结论

本次不新增 npm 包。路径、手势和签名都可由现有 Node.js 与自动化协议清晰实现，增加依赖不会带来更稳定的跨框架语义。
