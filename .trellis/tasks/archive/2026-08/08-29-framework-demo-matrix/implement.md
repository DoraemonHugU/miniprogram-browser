# 三框架公开 Demo 矩阵执行计划

- [x] 调研 Taro 与 uni-app 官方模板、构建命令、当前兼容版本、维护状态和 license；记录选择依据。
- [x] 实现 `demo/taro-demo`，生成锁文件并验证干净安装、构建和编译后路由。
- [x] 实现 `demo/uni-app-demo`，生成锁文件并验证干净安装、构建和编译后路由。
- [x] 新增三框架统一契约测试，先验证测试能覆盖结构、行为和安全边界，再跑根项目测试。
- [x] 更新 README、产品契约与 Skill，明确三套 Demo 共用一套 CLI 调试协议。
- [x] 在 Mac 微信开发者工具分别运行 Taro、uni-app 的真实 gate：open → inspect → snapshot → controls → repeated list → navigation/back → screenshot → close。
- [x] 执行 build、strict typecheck、lint、全量测试、pack check、diff check 和保密扫描；确认临时截图/session 清理完成。

## 验证命令

```bash
npm ci --prefix demo/taro-demo
npm run build:weapp --prefix demo/taro-demo
npm ci --prefix demo/uni-app-demo
npm run build:mp-weixin --prefix demo/uni-app-demo
npm test
npm run typecheck:strict
npm run lint
npm run pack:check
git diff --check
```

真实 DevTools gate 使用根 CLI 的构建产物和独立 session；遇到真实登录、AppID 或 DevTools 错误时保留原始信号，不读取生产项目内容。

## 完成验证（2026-08-29）

- Taro 与 uni-app 均完成锁文件安装、微信构建和独立类型检查；统一 Demo 测试与原生 Demo 测试合计 8/8 通过。
- 根项目 `npm test` 全量通过，其中 Node 测试 307/307、图像处理测试 19/19；`typecheck:strict`、`lint`、`git diff --check` 均通过。
- Mac 真实 DevTools 已覆盖两套框架的完整交互 gate；uni-app 移除框架默认 CDN 预加载后又完成 open、snapshot、exception、close smoke，session 清单为空。
- 保密扫描未发现真实 AppID、业务 URL、网络/存储调用、生产路径、图片或日志；三套配置均为 `touristappid`。
- `npm pack --dry-run` 为 29 个文件、118.4 kB；不包含 `demo/`、截图、日志或凭据。
