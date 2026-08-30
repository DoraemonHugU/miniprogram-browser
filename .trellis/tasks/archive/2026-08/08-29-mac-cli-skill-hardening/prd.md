# Mac CLI 与 Skill 加固

## Goal

让 `miniprogram-browser` 在 macOS 上具备可重复验证的启动、连接、交互、截图、诊断和关闭链路，并让配套 Skill 准确描述这些行为和边界。

## Requirements

### R1. 生产信息隔离

- 真实业务小程序只允许作为本机临时诊断目标，禁止将其源码、配置、AppID、路径、页面文案、截图、日志或运行数据写入本仓库及其发布物。
- 自动化测试、文档和示例只能使用人工合成的公开 Demo；Demo 使用 `touristappid`，不依赖真实账号、后端或业务数据。
- 提交前必须检查 Git diff 和 npm 打包清单，确认没有本机路径、运行日志、截图或私有项目内容。

### R2. macOS 可重复验证

- 默认识别 macOS 微信开发者工具 CLI，并在服务端口已开启时完成 `open -> doctor -> snapshot -> fill/click/get -> screenshot -> close`。
- Node/Python 测试不得依赖手工设置 `TMPDIR=/private/tmp`；测试必须正确处理 macOS `/var` 与 `/private/var` 的等价路径。
- Windows、WSL、macOS 平台测试必须显式注入平台信号，不得意外读取执行测试机器的 `process.platform`。

### R3. 有界启动与诊断

- `open` 和 `doctor` 的 `--timeout` 必须覆盖 DevTools CLI 启动、等待端口和运行时 probe 的完整链路。
- 超时或登录/AppID/CLI 路径失败时必须返回稳定、可读的错误和原始 DevTools 信号；JSON 模式不得沉默等待。
- `doctor.ok`、`probe.connected` 和 `probe.appReady` 必须含义清楚，不得把“只有 Tool 层连接”误写成 App runtime 已可用。

### R4. macOS DevTools 日志发现

- `devtools logs` 必须找到当前 macOS 用户数据目录中的有效 `WeappLog`，不能假设目录名是安装路径的 MD5。
- 多个候选目录时采用可解释、可测试的活跃目录选择规则；没有日志时返回明确诊断。

### R5. Ref 几何与截图边界

- 同一 selector 下的多个节点必须保留各自索引，`layout`/ASCII map 的矩形不能全部落到第一个元素。
- `@e` 点击解析语义保持不变，并增加两个同类按钮的回归测试。
- 默认截图继续写入系统临时目录。显式把截图写进小程序项目目录时，CLI 必须提示 DevTools 文件监听可能触发重新编译和运行态重置。
- 项目外 `page` 截图不得改变当前页面状态。

### R6. Skill 同步

- Skill 必须覆盖 macOS 首次启用服务端口、登录过期、默认临时截图、项目内截图副作用、`@e` 生命周期和真实 E2E gate。
- Skill 保持任务导向，正常路径优先，平台和诊断细节作为边界说明，不新增无必要的用户配置负担。

### R7. 截图输出路径

- 省略输出路径时继续写入系统临时目录，并由 CLI 生成不覆盖旧文件的 PNG 文件名。
- 显式路径支持当前宿主系统的相对路径和绝对路径；相对路径以调用命令时的工作目录为基准。
- 显式路径指向已有目录，或以当前平台目录分隔符结尾时，CLI 在该目录内生成不覆盖旧文件的 PNG 文件名。
- 显式文件路径的父目录不存在时由 CLI 创建；不得要求用户手工预建目录。
- 输出路径保持位置参数 `screenshot [path]`；误写 `--path` 必须返回明确的 usage error，不得静默忽略后写入默认临时目录。
- 路径解析优先使用成熟平台能力；新增第三方依赖前必须确认内置 `node:path` / `node:fs` 不能满足需求。

### R8. 截图默认语义与自动命名

- `screenshot` 省略 `--mode` 时必须产出真实页面 PNG（`page`）；结构布局图只能通过显式 `--mode layout` 请求。
- 自动文件名只保留用户或 Agent 能理解的事实：固定 `mpb` 前缀、项目、页面、模式。
- session 名和 route hash 不进入文件名；同名冲突由现有原子 `-1`、`-2` 后缀解决。
- 标准路由尾部为 `index` 时使用上一级页面名，例如 `/pages/components/button/index` → `button`。
- 不新增 artifact 管理命令、截图耗时、字节数或输出类型等非业务字段。

### R9. Snapshot 主路径与确定性 refs

- 无参数 `snapshot` 必须直接提供 compact 语义树与紧凑 ASCII 空间图；`--layout` 只追加精确比例坐标，`--no-map` 关闭默认空间图。
- 每次完整 snapshot 从 `@e1` 按当前规范语义树顺序重建并替换旧 refs；相同树与顺序产生相同编号，结构变化后不承诺持久编号。
- 默认 JSON 只保留 route、count 和紧凑 records，不重复 lines 或每条 record 的 route。
- 等价的相对/绝对 `--project` 不得触发 session 绑定冲突。
- 三套公开 Demo 首页使用标准 navigator 语义；L0 必须真实点击可操作 ref，缺失或点击失败均为硬失败。

## Acceptance Criteria

- [x] 仓库只包含人工合成 Demo；敏感信息检查、`git diff` 和 npm pack 清单均无真实业务内容。
- [x] `npm run build`、`npm run typecheck:strict`、`npm run lint`、Node 全量测试、Python 全量测试、`npm run pack:check` 全部通过。
- [x] macOS 测试在默认环境直接通过，不需要 `TMPDIR` workaround。
- [x] `open/doctor --timeout 2000` 的失败路径在合理容差内结束并输出 JSON 错误。
- [x] `devtools logs` 能在 macOS 返回实际活跃 `WeappLog` 文件，或给出明确的无日志诊断。
- [x] 合成 Demo 中两个 `button` 的 ref/rect 可区分，`Say hello` 与 `Reset` 均命中正确元素。
- [x] 项目外 `screenshot --mode page` 前后页面数据一致；项目内输出路径产生明确警告。
- [x] 合成 Demo 的真实 Mac 链路完成 `open -> doctor -> snapshot -> fill -> click -> get -> layout/page screenshot -> close`。
- [x] Skill 文档测试通过，且 Skill 与 CLI 最终行为一致。
- [x] 相对/绝对文件路径、已有目录、尾分隔符新目录和默认临时目录均有跨平台隔离测试并通过。
- [x] 截图路径实现未新增依赖，README、Skill、Help 与截图契约描述一致。
- [x] `screenshot` 默认真实 `page`，自动文件名符合 `mpb-<project>-<page>-<mode>.png`，并发冲突继续安全避让。
- [x] CLI/Skill/README 不新增 artifact 管理与截图性能字段，三者对默认截图语义描述一致。
- [x] 无参数 snapshot、确定性 refs、紧凑 JSON、相对项目路径和公开 Demo navigator 均有回归测试并通过。

## Out of Scope

- 真实业务小程序功能、视觉或接口验证。
- 上传、预览、真机调试和发布流程。
- Windows GUI 自动化、OCR、键盘驱动或后台文件同步。
- 与上述验收标准无关的重构、依赖升级或功能扩展。
