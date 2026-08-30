# 框架依赖调研（2026-08-29）

## Taro

- 官方文档确认 Taro 3+ 直接支持 React，并以小程序 entry/page 规范组织应用；微信构建命令为 `taro build --type weapp`。
- npm registry 当前 `@tarojs/cli`、`@tarojs/taro`、`@tarojs/react`、`@tarojs/components`、React framework/plugin、WeChat platform plugin 与 webpack5 runner 的稳定 tag 都是 `4.2.1`，仓库均指向 `NervJS/taro`，license 为 MIT。
- 选择：相关 Taro 包精确锁定 `4.2.1`，避免同一工具链版本漂移；React 版本按 Taro 4 官方模板/peer 约束确定，不直接采用 registry 上与模板尚未验证的最新 major。

## uni-app

- DCloud 官方 `uni-preset-vue` 的 `vite-ts` 模板确认微信构建命令为 `uni build -p mp-weixin`，当前模板使用 Vue 3、Vite 5.2.8 和一组完全一致的 DCloud CLI 版本。
- `@dcloudio/uni-app`、`@dcloudio/uni-mp-weixin`、`@dcloudio/vite-plugin-uni` 均来自 `dcloudio/uni-app`，license 为 Apache-2.0。
- npm 的无 tag `latest` 对部分 DCloud 包仍指向旧分支，不能混装；选择官方 `vite-ts` 模板中的同组版本并以 lockfile 固定，避免跨发行线组合。
- 当前官方模板默认开启 `uniStatistics`；公开 Demo 在根级与 `mp-weixin` 级均显式设为 `false`。关闭后构建输出不再提示开启 uni 统计，真实 DevTools 日志也没有统计关键字。
- DCloud 的生产运行时仍会生成 `wx.preloadAssets`，在 3 秒后请求其 CDN 阴影图，且官方讨论没有提供关闭开关。Demo 的构建命令因此在编译后执行一个固定版本、失败即中止的最小清理脚本，并由编译产物测试确认 `wx.preloadAssets` 与 `shadow-grey.png` 均不存在。

## 约束

- 两套框架都持续维护且有官方文档与仓库；Demo 只引入完成微信构建所需的主流包。
- 不引入第三方 UI 库、路径库、测试框架或运行时网络依赖。
- 官方资料：
  - https://docs.taro.zone/en/docs/GETTING-STARTED
  - https://docs.taro.zone/en/docs/react-overall
  - https://docs.taro.zone/en/docs/folder
  - https://github.com/dcloudio/uni-preset-vue/tree/vite-ts
  - https://github.com/dcloudio/uni-app
  - https://uniapp.dcloud.net.cn/uni-stat-public
  - https://github.com/dcloudio/uni-app/issues/1803

## Mac 运行观察

- Taro 与 uni-app 均完成目录、控件、动态列表、重复文本选择、前进/返回、默认临时截图与关闭 gate；截图人工核对后移入废纸篓，三个 Demo 的 session 均为空。
- 当前微信开发者工具 `2.02.2608040` 通过 automation 连接后会给原生与 uni-app 项目各产生同样的 5 条 `error {}`，两者的 `exceptions` 均为空。这是 DevTools/automation 基线噪音，不是 uni-app 统计或 Demo 业务错误；不能把不可读的空对象当作框架回归。
