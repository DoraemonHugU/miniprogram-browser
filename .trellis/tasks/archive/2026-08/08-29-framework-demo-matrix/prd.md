# 三框架公开 Demo 矩阵

## Goal

为原生、Taro、uni-app 建立同一微信小程序调试行为契约并完成构建与 Mac 真机 gate。

## Requirements

- 保留现有 `demo/public-demo` 作为微信原生基线，并新增标准 Taro React + TypeScript、uni-app Vue 3 + Vite Demo。
- 三套 Demo 必须提供相同的五页调试面：目录首页、表单控件、动态列表、页面导航、详情页；业务文案和数据全部为公开合成内容。
- Taro 与 uni-app 必须采用各自官方支持的工程结构、构建命令和兼容版本；依赖版本固定在各自锁文件中，构建产物不提交。
- 每个框架工程根目录都必须可交给微信开发者工具；`project.config.json` 通过 `miniprogramRoot` 指向其编译后微信小程序目录。
- `miniprogram-browser` 对三套产物走同一套命令与行为契约，不增加 Taro/uni-app 特判、框架识别或额外用户配置。
- 不接入网络请求、账号、存储、真实 AppID、私有路径、生产截图或生产数据；只允许 `touristappid` 和合成测试数据。
- 新增测试覆盖三套项目的路由与行为契约、框架入口、构建输出和保密边界，防止后续回退。

## Acceptance Criteria

- [x] Taro 与 uni-app 工程均能以锁文件全新安装并成功构建微信小程序产物。
- [x] 三套 Demo 的编译后 `app.json` 都注册同一组五条路由，并具备控件、动态列表与前进/返回导航能力。
- [x] 三套根 `project.config.json` 都只使用 `touristappid`，且能解析到真实存在的编译后 `app.json`。
- [x] 静态测试能发现路由缺失、非合成 AppID、网络/存储调用和框架入口缺失。
- [x] 在当前 Mac 的真实微信开发者工具上，Taro 与 uni-app 分别通过 open、inspect、snapshot、控件、重复列表、导航、截图和 close gate。
- [x] 根项目 build、strict typecheck、lint、完整测试与 pack check 通过；包内容不包含 Demo、截图、日志或凭据。
- [x] README、CLI 产品契约和 Skill 对三套 Demo 的用途与同一调试协议保持一致，不引入框架专用 CLI 命令。

## Out of Scope

- 支持新的第四种框架、H5/App 构建或 UI 组件库本身。
- 把生产项目、生产截图或任何真实业务内容转换成示例。
- 发布 npm 包、提交 Git commit、推送远端或创建 PR。
