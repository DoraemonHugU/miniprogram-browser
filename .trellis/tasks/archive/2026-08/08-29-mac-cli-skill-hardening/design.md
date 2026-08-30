# Design：Mac CLI 与 Skill 加固

## 1. 边界与原则

- 所有可提交证据来自人工合成 Demo，不引用任何真实业务项目。
- 保持现有 CLI 命令面，不新增依赖；优先修正参数传播、路径选择和 ref 元数据。
- 默认行为安全：截图写系统临时目录、业务命令复用 live runtime、失败保留 DevTools 原始信号。
- 真实 DevTools gate 是补充验证，不替代单元测试。

## 2. 合成 Demo

新增最小公开 Demo（`demo/public-demo`）：

- `touristappid`；无网络请求、密钥和外部资源。
- 一个输入框、两个同类 `button`、动态状态和计数。
- 同时验证 `fill/get value`、两个 button 的 ref 解析、动态文本、截图和关闭。
- npm 发布清单是否包含 Demo 由现有 allowlist 决定；不得把运行截图或 DevTools 日志打入包。

## 3. macOS 路径与测试

### 3.1 临时路径

测试统一通过平台 API 获取并规范化临时目录，不硬编码 `/tmp`。对需要比较身份的路径，比较规范路径；展示和传给 DevTools 的原始项目路径保持可观察。

### 3.2 平台注入

Windows/WSL 分支测试显式注入 `runtime`、`readProcVersion`、`wslDistroName` 和 CLI bundle 形态。Fake CLI 使用可执行 wrapper，避免在 macOS 上把非可执行 `cli.js` 当真实 CLI。

## 4. 超时预算

```
open/doctor --timeout
  -> absolute deadline
  -> live probe
  -> enableAutomation(remainingMs)
  -> runDevtoolsCli(timeoutMs=remainingMs)
  -> wait-live/probe(remainingMs)
```

- `spawnSync` 会阻塞事件循环，不能只依赖外层 `Promise.race`。
- `handleDoctor` 和 `connectOrEnable` 必须把剩余预算传给 `enableAutomation`。
- DevTools CLI 超时统一映射为包含 phase、timeout 和原始进程结果的错误；不吞掉登录/AppID 等更具体信号。

## 5. macOS 日志发现

macOS 的 DevTools 用户目录 hash 不是安装路径 MD5。日志发现改为：

1. 以 `~/Library/Application Support/微信开发者工具` 为用户数据根目录；
2. 枚举直接子目录中的 `WeappLog`；
3. 以最新日志文件的 `mtime` 选择活跃候选；
4. 返回选择依据；无候选时返回明确诊断。

Windows/WSL 现有 install-path/launch-log 逻辑保持不变。

## 6. Ref 几何

当前语义快照转换丢失节点 `index`，`collectRecordRects` 随后把同 selector 记录全部映射到 `elements[0]`。交互解析之所以仍正确，是 `resolveRecord` 会用 stableKey 在新树上重新计算 selector index。

最小修复：

- 在语义/原始快照节点中保留运行时 `index`；
- ref record strategy 带正确 index；
- `collectRecordRects` 增加重复 selector 测试，确认两个 button 得到不同 rect；
- 不改变 stableKey 和 `@e` 分配规则。

## 7. 截图副作用

已验证 `App.captureScreenshot` 本身不重置页面。状态重置来自把输出 PNG 写入小程序项目目录后，DevTools 文件监听触发重新编译。

处理方式：

- 默认无路径截图继续写系统临时目录；
- 检测显式输出路径是否位于 `projectPath` 内；若是，在结果 `notices`/文本输出中提示可能重新编译；
- 不尝试通用恢复页面 data 或生命周期，因为无法安全恢复业务副作用；
- Skill 引导 Agent 优先省略路径，或写到项目外。

## 8. `doctor` 语义

保持三层事实分离：

- Tool endpoint：`probe.connected`
- App runtime：`probe.appReady`
- 命令总体：`ok`

`ok` 只有在请求的诊断目标满足时才为 true；若 Tool 可连但 App 不可用，JSON 必须明确返回非就绪状态和下一步，不得只显示成功。

## 9. Skill

Skill 只同步最终、已测试行为：

- 正常路径：`open -> snapshot -> action --follow -> get/await -> screenshot -> close`；
- macOS 首次设置和登录过期诊断；
- ref 为 snapshot-scoped；
- 截图默认临时目录，项目内路径可能触发重新编译；
- 示例只引用公开 Demo。

## 10. 截图输出路径解析

调研结论见 `research/path-libraries.md`。使用 Node 内置 `node:path` 与 `node:fs/promises`，不新增运行时依赖：

- 路径最终用于当前宿主机文件系统，必须遵循当前 runtime 的 Windows/POSIX 语义；统一改成 `/` 反而会掩盖 drive、UNC 与分隔符差异。
- 相对路径通过 `path.resolve(cwd, input)` 解析；绝对路径由同一 API 保持为绝对结果。
- 已存在目录通过 `stat().isDirectory()` 判断；不存在但以当前平台分隔符结尾的输入视为目录意图并递归创建。
- 显式目录复用 `allocateTempScreenshotPath` 生成短文件名并原子避让；显式文件路径递归创建父目录但保留用户文件名。
- 路径解析函数允许注入 `path.posix` / `path.win32`，跨平台测试不读取测试宿主的 `process.platform`。

兼容边界：不存在且没有尾分隔符的输入仍按文件路径处理，避免把现有无扩展名输出文件静默改成目录。

## 11. 截图产品语义与文件名

截图面向 Agent，也可能直接交给用户查看，因此默认行为和文件名都必须表达业务事实：

- `screenshot` = 真实页面 PNG；`snapshot` = 语义结构；`screenshot --mode layout` = 显式结构图。
- 自动命名：`mpb-<project>-<page>-<mode>.png`。
- 页面 token 取路由尾部；尾部为 `index` 时取上一级，例如 `/pages/index/index` → `index`、`/pages/components/button/index` → `button`，其他路由保留最后两段。
- 不使用 session、时间戳或 hash；原子 `open(..., 'wx')` 已足以通过 `-1`、`-2` 处理并发与重复截图。
- 显式文件路径仍由用户完全命名；只有自动生成路径使用上述规则。
- JSON 不增加性能与文件管理字段；路径本身是调用方继续查看图片所需的唯一新增事实。

这一变更不做平台特判，也不在真实截图失败时静默返回 layout。

## 12. Rollback

- 每类修复保持独立测试和小 diff，可单独回退。
- 不迁移现有 session schema；新增字段必须可选并兼容旧状态。
- 真实 gate 失败时保留单元测试修复，不以修改生产项目规避失败。

## 13. Snapshot 与 ref 收口

- 完整 snapshot 先为当前完整规范语义树从 `@e1` 确定性编号，再按默认 compact / depth / scope 过滤展示；这样 compact 与完整视图引用同一节点时编号一致。
- 写入 session 时用当前 snapshot 世代完整替换旧 refs；`stableKey` 仍用于 snapshot 后动作执行前的当前树重解析，不再承担跨 snapshot 编号累积。
- 默认收集比例 rect 仅用于 32×24 上限的 ASCII 图；普通 text/label 只画编号，连续空行折叠。只有 `--layout` 把 rect 写入语义文本。
- `assertBindingConsistency` 比较前使用既有 `normalizeProjectPath`，不增加路径依赖或平台分支。
- Demo 首页统一使用原生 navigator 语义（Taro `Navigator`、uni-app `<navigator>`）；L0 优先点击 navigator/link，再退到 button，任何点击失败都终止 gate。
