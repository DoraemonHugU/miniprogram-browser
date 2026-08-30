# 三框架公开 Demo 矩阵设计

## 边界

`demo/public-demo` 是原生源码即运行目录；`demo/taro-demo` 与 `demo/uni-app-demo` 是可复现构建的框架源码。后两者各自维护依赖与锁文件，生成目录由仓库现有 `dist/` 忽略规则排除。

## 统一行为契约

三套产物统一注册以下路由：

1. `pages/index/index`：列出测试入口。
2. `pages/controls/index`：输入、按钮、switch、checkbox、radio 及可读结果。
3. `pages/lists/index`：添加项目、重复文案的选择/删除按钮及稳定 item 标识。
4. `pages/navigation/index`：跳转详情页。
5. `pages/detail/index`：展示参数并返回上一页。

源码遵循各框架惯用写法，不抽取跨框架 UI 层。统一的是编译后行为和语义文案，不是源码实现。

## 工程与运行时

- Taro：React + TypeScript，官方 `taro build --type weapp`，输出 `dist/`。
- uni-app：Vue 3 + Vite，官方 `uni build -p mp-weixin`，输出 `dist/build/mp-weixin/`。
- 两个根 `project.config.json` 设置 `appid: touristappid`，用 `miniprogramRoot` 指向对应输出。
- CLI 从工程根的 `project.config.json` 发现实际原生产物；后续命令只面向微信 DevTools automation，不判断上游框架。

## 测试分层

- 默认单测：读取源码与配置，验证路由、功能和安全契约，不安装嵌套依赖。
- 框架构建：每个 Demo 独立 `npm ci` 与 build，再验证输出 `app.json` 和页面文件。
- Mac gate：仅针对已经构建的公开合成 Demo，逐一创建独立 session，走相同 CLI journey，截图写系统临时目录并在检查后移入废纸篓。
- 最后执行根项目全量测试和包清单检查，确认 `demo/` 不进入 npm 包。

## 兼容与回滚

依赖使用官方当前稳定或官方 Vue 3 模板的同组版本，并以锁文件固定。若某框架构建失败，只回滚对应 `demo/<framework>-demo` 与其测试/文档，不改变 CLI 稳定面。

## 取舍

- 不在根 `npm test` 中隐式安装大型框架依赖，避免普通 CLI 回归变慢且依赖网络。
- 不提交构建产物；真实 gate 之前显式构建，保证产物可再生。
- 不增加框架专用参数；编译结果本来就是标准微信小程序，应自然复用现有路径发现与 automation 能力。
