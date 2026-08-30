# Design：Windows 游客态 automation 诊断

## 1. 已确认事实

- macOS 与 WSL UNC 默认直接执行 `auto`；Windows/WSL 盘符路径自 `5f52384` 起执行 `open → auto`，用于规避既往冷启动 cli server/plugin 未就绪。
- DevTools `2.02.2608060` 游客态中，`islogin` 返回 `false`，但服务端口和 Tool endpoint 可正常连接。
- `open --project <touristappid>` 返回 `code 10 / 不存在此 AppID`。
- direct `auto` 在 warm/cold、普通/`--pure-simulator` 组合中均可打印 `Using AppID: touristappid / ✔ auto`，但 App runtime 不响应 `App.getCurrentPage`。
- 显式传 `--appid touristappid` 会触发权限查询并返回 `code 10 / 需要重新登录`。

## 2. 决策

### 2.1 不改变 Windows 冷启动策略

仅跳过 pre-open 不能获得可用 App runtime，只会把确定的 `open` 失败延后为 Tool-only 超时。因此本 PR 不把 `touristappid` 特判成 direct `auto`，也不把 `✔ auto` 当成完整成功。

### 2.2 收紧 `code 10` 分类

- 登录：只匹配 `INVALID_LOGIN`、`access_token`、41001/42001/42002、`需要重新登录`、`请先登录`、`not login`、`please login`。
- AppID：匹配 `appid missing`、41002、`不存在此 AppID` 及明确的英文等价表述。
- 裸 `code 10` 不再决定错误类型；raw 始终保留。

### 2.3 Tool-only 状态禁止订阅 App 事件

`miniprogram-automator.on('console')` 会内部 fire-and-forget 调用 `App.enableLog`。当前 `withMiniProgram` 在 `appReady=false` 时仍注册 console/exception，Tool-only endpoint 关闭后该 Promise reject 会成为未处理 rejection。只有 App runtime ready 后才注册和移除这些 App 级事件；Tool-only 状态只允许 Tool/App readiness probe。

### 2.4 文档边界

- `touristappid` 只保证公开 Demo 不携带生产身份。
- GUI 游客模式、Tool endpoint、App runtime 三层状态分开描述。
- Windows `open → auto` 与 macOS direct `auto` 的差异保留并说明历史原因。

### 2.5 Windows batch argv

Windows 的官方入口是 `.bat`，必须经过 `cmd.exe /S /C`；macOS CLI 可直接执行。把 batch 路径和参数作为分散 argv 交给 `cmd.exe` 时，后者会再次解析并截断带空格的项目路径。Windows 路径改为单个命令串，外层满足 `/S /C` 引号规则，内部逐项引用 CLI 路径和 argv，并启用 `windowsVerbatimArguments` 防止 Node 再次转义引号。

## 3. 兼容性与回滚

- 不改变公共命令、参数或 session schema。
- 已登录、真实合法 AppID 和 macOS 启动路径不改变。
- 回滚可直接撤销错误分类、事件订阅门禁和文档测试；无数据迁移。

## 4. 验证

- 单测使用合成 CLI raw 和可控延迟 Promise。
- 真实门禁只使用仓库公开 `demo/public-demo` 的 Windows 临时副本。
- 游客态真实 gate 预期仍可能失败，但必须准确报告 `不存在此 AppID`，不得伪报成功或访问生产项目。
