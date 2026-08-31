# 项目规范

这里保存 `miniprogram-browser` 自行维护的产品与实现契约。行为变更时同步相关规范、测试与 Skill；规范不是任务审批或自动执行流程。

## 按改动范围阅读

| 规范 | 范围 |
|------|------|
| [CLI 产品契约](cli/product-contracts.md) | 公共命令、默认行为、`@e` 生命周期、成功/失败输出、框架中立性 |
| [Session 契约](cli/session-contracts.md) | 项目绑定、活动 session、runtime 复用、端口、持久化和清理 |
| [平台识别与路径](cli/platform-detection.md) | macOS / Windows / WSL 判定、路径转换、新旧 DevTools CLI 入口 |
| [截图与视觉契约](cli/screenshot-contracts.md) | 真实截图与结构图、默认模式、输出路径、命名、并发避让 |
| [ASCII 空间图契约](cli/ascii-map-contracts.md) | 百分比几何、层级线框、ref 映射、标签避让和紧凑输出 |

## 维护约定

- [AGENTS.md](../../AGENTS.md) 是协作规则入口；[CLI Skill](../../skills/miniprogram-browser/SKILL.md) 面向实际使用工具的 Agent。
- 规范记录已确定的行为、边界、失败情况及对应验证，不把历史任务状态当作当前实现。
- 发现规范与代码冲突时，先检查调用链与测试，再明确修正规范或实现。
- 新规范只在已有文档不能清楚容纳该契约时添加，不为每次修改创建模板、任务文件或日志。
- 探索方向与未验证能力放在 [ROADMAP.md](../../ROADMAP.md)，不得写成已交付承诺。
- 规范中的测试清单描述验收要求，不代表对应平台已通过；交付时分别报告本轮实际运行、失败及跳过的检查。
