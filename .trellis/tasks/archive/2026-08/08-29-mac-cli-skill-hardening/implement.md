# Implement：Mac CLI 与 Skill 加固

## 0. 安全门禁

- [x] 只使用 `demo/public-demo` 或临时合成 Demo；不再打开真实业务项目。
- [x] 修改前后检查 Git diff、未跟踪文件和 npm pack 清单。
- [x] 不在文档、测试名、fixture、日志或截图中写入真实项目标识。

## 1. 固化回归测试

- [x] 为重复 selector 节点补充 `index`/rect/两个 button 点击回归测试。
- [x] 为 macOS 日志候选发现补充临时目录测试。
- [x] 为 `open/doctor` 完整 timeout 预算补充 fake CLI 超时测试。
- [x] 修正 macOS `/var`/`/private/var` 与 fake CLI 可执行性测试夹具。
- [x] 为项目内截图路径 warning 和项目外无副作用补充测试。

验证：新增测试先失败，并能分别指向对应根因。

## 2. 最小产品修复

- [x] 保留 snapshot 节点 selector index，修正 layout/ASCII 几何。
- [x] 将剩余 timeout 预算传入 DevTools CLI 同步调用和 probe。
- [x] 在 macOS 按活跃 `WeappLog` 候选发现日志目录。
- [x] 明确 `doctor.ok` 与 `appReady` 的关系和失败输出。
- [x] 检测截图输出路径位于项目内并返回 notice。
- [x] 只清理由本次改动产生的 lint/未使用代码。

验证：相关 Node 测试、`npm run build`、`npm run typecheck:strict`、`npm run lint`。

## 3. 公开 Demo 与 Skill

- [x] 将已复核的纯合成 Demo 以最小文件集纳入约定位置。
- [x] 确认 Demo 无网络、密钥、真实 AppID、业务文案和本机路径。
- [x] 更新 Skill 的 macOS、ref、截图和真实 gate 说明。
- [x] 必要时只更新 README 的公开 Demo 使用入口，不扩写无关内容。

验证：Skill 文档测试、敏感信息人工审查、npm pack 清单。

## 4. 全量验证

- [x] `npm run build`
- [x] `npm run typecheck:strict`
- [x] `npm run lint`
- [x] `npm test`
- [x] Python 全量测试
- [x] `npm run pack:check`
- [x] 在 macOS 用公开 Demo 串行执行真实链路：
  - [x] `open`
  - [x] `doctor`
  - [x] `snapshot`
  - [x] `fill` / `get value`
  - [x] `click` 两个同类 button / `get text`
  - [x] `screenshot --mode layout`
  - [x] 项目外 `screenshot --mode page`，确认状态不变
  - [x] `devtools logs`
  - [x] `close`，确认端口和 session 清理

## 5. 审查与回滚点

- [x] 逐项核对 PRD acceptance criteria。
- [x] 检查没有新增依赖和无关重构。
- [x] 检查 Git diff 中没有真实业务信息、运行截图或本机日志。
- [x] 若真实 DevTools 行为与 mock 测试不一致，停止发布并保留准确的未验证说明。

## 6. 截图输出路径

- [x] 记录 `node:path`、`pathe`、`upath` 的维护状态、license、兼容性与选型结论。
- [x] 先为 POSIX/Windows 相对路径、绝对路径、已有目录、尾分隔符新目录、父目录创建补测试。
- [x] 在 `temp-artifacts` 集中实现路径解析，`handleScreenshot` 只消费解析结果。
- [x] 同步 CLI Help、README、Skill 与 `screenshot-contracts.md`。
- [x] 运行相关测试、全量测试、lint/typecheck、pack 与敏感信息审计。

## 7. 截图默认语义与自动命名

- [x] 先更新测试：默认 mode 为 page；文件名移除 session/hash 并保留原子冲突后缀。
- [x] 最小修改默认 mode、route token 和命名字段，删除由此产生的未使用参数。
- [x] 同步 CLI Help、README、Skill 与 screenshot 产品契约。
- [x] 用公开 Demo 验证省略 mode 的真实 PNG 和重复截图 `-1` 避让。
- [x] 为误写 `--path` 补充先失败后通过的回归测试，并返回明确的 usage error。
- [x] 运行全量测试、pack 与敏感信息审计，不引入 artifact 命令或性能字段。

## 8. Snapshot 主路径收口

- [x] 先补确定性 ref、默认 ASCII policy、紧凑 JSON、相对项目路径、navigator 与 L0 硬点击回归测试，并确认旧实现失败。
- [x] 完整 snapshot 改为从 `@e1` 确定性重建并替换上一世代；默认 compact，`--all` 保留完整视图。
- [x] 默认输出 32×24 上限的压缩 ASCII；普通文字不画框，连续空白行折叠；`--layout` 仅追加精确 rect。
- [x] 规范化 session 绑定路径，三套 Demo 首页统一标准 navigator，L0 点击改为硬门禁。
- [x] 同步 Help、README、Skill、CLI 产品/截图/ASCII/session 契约和 Roadmap。
- [x] 运行 Skill validator、全量测试、lint/typecheck、pack、隐私扫描与公开 Demo Mac 真机 gate。
