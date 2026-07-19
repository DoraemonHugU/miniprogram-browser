# Design：CLI 行为测试修复与跨平台 open 路径

## 根因图

```
cli-behavior tests
  ├─ seed via open (no/malformed CLI)
  │     → open fails → clearSessionState → list []
  └─ fake `#!/bin/sh` cli
        → WSL win32 host validates node.exe next to cli
        → throw before spawn → no calls.log / wrong error code
```

## 方案

### A. Session 种子（R1）

在 `tests/cli-behavior.test.cjs` 增加：

```js
async function seedSession(homeDir, { name, projectPath, autoPort = '9515', devtoolsPort = '' }) {
  process.env.HOME = homeDir // or pass via config stateRoot if available
  const config = mergeConfigOverrides(createDefaultConfig(), { projectPath, autoPort, devtoolsPort })
  const state = createEmptySessionState(name, config)
  // strip runtime on save is OK for list tests; for kill-lock tests need autoPort in memory after load
  await saveSessionState(state)
  return state
}
```

注意：`stripRuntimeFields` 会去掉 autoPort。kill 锁测试需要 load 后仍有 autoPort → 要么：

- 测前 `recordRuntimeLaunch` + `bindSessionRuntimeFromPool` 路径；或  
- 在 load 后手动写 `ownerState.config.autoPort`；或  
- 测试只断言 list 名字，锁测试单独 `recordRuntimeLaunch`。

推荐：**list/kill 作用域** 只 seed session 元数据；**runtime lock** 测试 seed session + `recordRuntimeLaunch`，load 后从 launch 回绑或直接 set autoPort。

### B. Fake DevTools CLI（R2/R3）

```js
function createFakeDevtoolsCli(scriptBodyLines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-fake-devtools-'))
  const callsPath = path.join(dir, 'calls.log')
  // 始终写 cli.js（官方入口名）+ 可执行 wrapper
  // win32 host：旁路 node.exe stub 转发到 shell 实现
  // 实现策略：
  // 1) cli.js 内容为 node 脚本：spawn 记录 args 并 echo 约定输出
  // 2) node.exe：在 Linux/WSL 放可执行 shell `node.exe` 调用 `node cli.js "$@"` 或直接 `#!/bin/sh` 实现
}
```

更稳：**fake 用 Node 写 `cli.js`**，行为完全可控；`node.exe` 在 WSL 做成：

```sh
#!/bin/sh
exec node "$(dirname "$0")/cli.js" "$@"
```

`runDevtoolsCli` 在 win32 用 `node.exe cli.js args`，stub 转发即可。

macOS/linux 非 win32 host：直接 `cli` 可执行文件或 `cli.js` + X_OK。

统一 helper 返回 `{ cliPath, callsPath, dir }`，`cliPath` 指向校验能过的路径。

### C. 产品代码（R4，尽量不动）

仅当真实用户路径被误伤时再改 `validateAutomationCliConfig`。当前失败是测试假 CLI 形态不对 → **优先测试**。

### D. cleanup / timeout

fake CLI 被调用后，现有 open cleanup 逻辑应能写 `calls.log`。若 `missing-devtools-project-path` 导致不 close：检查 WSL 下 close 路径解析；可能需 fake 项目在 `/mnt/...` 或 mock `toWindowsPath`。若仍 `reason=missing-devtools-project-path`，产品侧 close 路径是另一问题——本任务在测试里用可解析路径或断言当前真实 cleanup 语义并更新断言。

## 验证

```bash
npm run build
node --test tests/cli-behavior.test.cjs
node --test tests/runtime.test.cjs  # 抽检
```
