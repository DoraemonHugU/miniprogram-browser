# 技术设计

复用 `handleSessionList` 已有的项目过滤、Runtime launch index 和 endpoint probe 逻辑，抽出单个 Session 的状态投影，避免 `session info` 再实现一套绑定规则。

`session info` 默认使用活动 Session；指定名称时先用 `--project` 或当前项目解析 Session，避免同名跨项目误绑定。状态投影仅做只读 endpoint 探测，不能调用 `ensureSessionPorts`。

文本输出优先显示：

```text
session=work active=true status=live
project=/path/to/app route=/pages/index/index
runtime=attached owner=project-x1 autoPort=9527 devtoolsPort=39090
created=... updated=...
```

JSON 使用同一投影对象，并保留 `attachedTo`、`runtimeOwnerSession` 和 `selection` 字段，供 Agent 判断是否需要显式切换 Session。
