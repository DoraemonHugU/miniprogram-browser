# 技术设计

## 状态边界

- 活动 Session 存在项目级状态根目录，与 Session 文件和 Runtime launch registry（运行实例注册表）同属项目隔离状态。
- 只保存 Session 名称和更新时间，不保存 `autoPort`、DevTools 端口或连接句柄；这些仍由 Runtime 池实时回绑。
- 旧状态文件不存在活动指针时按兼容路径继续使用唯一 live Runtime 或自动 Session。

## 解析顺序

`ensureImplicitSessionName` 在未传 `--session` 时执行：

1. `MINIPROGRAM_BROWSER_SESSION`；
2. 项目活动 Session，前提是对应 Session 文件属于该项目且 Runtime 可回绑；
3. 现有逻辑生成/复用的 `{project}-xN`。

Runtime 选择仍由 `selectAttachableRuntimeSession` 负责：显式 Session 精确命中优先；无显式目标时只有唯一 Runtime 才可自动 attach，多 Runtime 返回 `ambiguous`。

为避免 Session 名称解析阶段做过多探测，活动指针只负责给出候选名称；真正的 live 校验仍在既有 Session/Runtime 绑定流程中完成。若活动 Session 无法绑定，主流程继续执行既有唯一 Runtime/多 Runtime 判定，不静默选最新。

## 活动指针写入

- `open/connect` 成功后写入项目活动 Session。
- `saveSessionState` 不自动更新活动指针，避免并行 Agent 执行 `snapshot`/`click` 时互相抢夺默认目标。
- 显式 `--session` 的非连接命令不改变活动指针；需要切换默认目标时重新 `open/connect --session <name>`。

## 兼容与失败

- 活动状态文件损坏时按不存在处理，不阻塞 CLI；成功写入时覆盖为合法 JSON。
- 多 Runtime 错误增加 `next` 和 `diagnostics.selectionReason`，保留现有 `MULTIPLE_LIVE_RUNTIMES` code。
- 环境变量只在没有命令行 Session 时生效，且仍经过项目绑定检查。
