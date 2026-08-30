# 截图输出路径库调研

调研日期：2026-08-29。

## 候选

### Node `node:path` + `node:fs/promises`

- Node 核心模块，`path` API 为 Stable。
- `resolve`、`isAbsolute`、`relative`、`dirname`、`win32`、`posix` 覆盖当前需求；`stat` / `mkdir({ recursive: true })` 覆盖目录判断与创建。
- 默认 API 按运行宿主采用 Windows 或 POSIX 语义，符合“最终写入当前宿主文件系统”的边界。
- 无新增依赖、license 或供应链成本，与项目 Node >=18 一致。
- 官方文档：https://nodejs.org/api/path.html

### `pathe@2.0.3`

- MIT；无运行时依赖；同时提供 ESM/CJS exports；npm 元数据最后更新时间为 2025-02-11。
- 目标是把所有平台输入统一成 POSIX `/` 形式，适合跨平台配置字符串和浏览器环境。
- 本任务要把文件写入真实宿主文件系统，不需要统一展示格式；引入后还会与现有 `node:path` 并存，收益不足。
- 官方仓库：https://github.com/unjs/pathe

### `upath@3.0.8`

- MIT；零运行时依赖；npm 元数据最后更新时间为 2026-07-05。
- 同样把结果统一成 `/`，并提供额外扩展名工具。
- 最新版要求 Node >=20，与本项目 Node >=18 不兼容；本任务也不需要其额外 API。
- 官方仓库：https://github.com/anodynos/upath

## 结论

使用 Node 内置 `node:path` 与 `node:fs/promises`。这不是自建路径算法，而是直接复用 Node 稳定、宿主感知的路径和文件系统能力；只增加一个项目内的产品语义适配层，用来区分“默认临时目录、显式文件、显式目录”。
