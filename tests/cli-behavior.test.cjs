const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const {
  acquireSessionLock,
  createDefaultConfig,
  createEmptySessionState,
  loadSessionState,
  listRuntimeLaunches,
  mergeConfigOverrides,
  recordRuntimeLaunch,
  releaseSessionLock,
  runtimeLockName,
  saveSessionState,
  setActiveSession,
} = require('../dist/lib/session-store.js')

const repoRoot = path.resolve(__dirname, '..')
const cliPath = path.join(repoRoot, 'dist/miniprogram-browser.js')

/**
 * WSL 上 close 路径若落在 /tmp→UNC 会被产品侧跳过。
 * 需要验证 close/auto 调用链的用例优先落在 /mnt/<drive>/...。
 */
function isWslRuntime() {
  if (process.platform !== 'linux') {
    return false
  }
  if (process.env.WSL_DISTRO_NAME) {
    return true
  }
  try {
    return /microsoft/iu.test(fs.readFileSync('/proc/version', 'utf8'))
  } catch (_) {
    return false
  }
}

function preferredProjectRoot() {
  if (!isWslRuntime()) {
    return os.tmpdir()
  }
  for (const candidate of ['/mnt/d/tmp/mpb-cli-behavior', '/mnt/c/tmp/mpb-cli-behavior']) {
    try {
      fs.mkdirSync(candidate, { recursive: true })
      const probe = path.join(candidate, `.write-${process.pid}`)
      fs.writeFileSync(probe, 'ok')
      fs.unlinkSync(probe)
      return candidate
    } catch (_) {}
  }
  return os.tmpdir()
}

const PROJECT_ROOT = fs.realpathSync(preferredProjectRoot())

function runCli(args, env = {}, options = {}) {
  const isolatedHome = env.HOME || fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-home-'))
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: options.cwd || repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: isolatedHome,
      USERPROFILE: env.USERPROFILE || isolatedHome,
      WECHAT_DEVTOOLS_CLI: '',
      WECHAT_DEVTOOLS_PROJECT: '',
      MINIPROGRAM_BROWSER_CLOSE_GRACE_MS: '0',
      ...env,
    },
  })
}

function parseJsonOutput(result) {
  assert.equal(result.stderr, '')
  return JSON.parse(result.stdout)
}

function createMiniProgramProject(baseDir = PROJECT_ROOT) {
  const projectDir = fs.mkdtempSync(path.join(baseDir, 'mpb-project-'))
  return createMiniProgramProjectAt(projectDir)
}

function createMiniProgramProjectAt(projectDir) {
  const miniprogramRoot = path.join(projectDir, 'miniprogram')
  fs.mkdirSync(path.join(miniprogramRoot, 'pages/index'), { recursive: true })
  fs.writeFileSync(path.join(projectDir, 'project.config.json'), JSON.stringify({ miniprogramRoot: 'miniprogram/' }))
  fs.writeFileSync(path.join(miniprogramRoot, 'app.json'), JSON.stringify({ pages: ['pages/index/index'] }))
  fs.writeFileSync(path.join(miniprogramRoot, 'pages/index/index.js'), 'wx.navigateTo({ url: "/pages/detail/index" })')
  return projectDir
}

/**
 * 跨平台假 DevTools CLI：
 * - Windows 走当前 cli.bat 入口；WSL 用旧 cli.js bundle 避免测试依赖 Windows Node
 * - macOS / 裸 Linux 直接执行 POSIX wrapper
 * - 三种入口都调用同一个 Node fixture，并记录 calls.log
 *
 * @param {{ onAuto?: string, onOpen?: string, onClose?: string, alwaysExit?: number, extraJs?: string }} [options]
 */
function createFakeDevtoolsCli(options = {}) {
  // 包含空格，确保 Windows cmd.exe 真实执行也覆盖常见安装路径。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb fake devtools-'))
  const callsPath = path.join(dir, 'calls.log')
  const cliJsPath = path.join(dir, 'cli.js')
  const onAuto = options.onAuto || '✔ IDE server has started, listening on http://127.0.0.1:38596'
  const onOpen = options.onOpen || onAuto
  const onClose = options.onClose || '✔ close'
  const alwaysExit = Number.isInteger(options.alwaysExit) ? options.alwaysExit : 0
  const extraJs = String(options.extraJs || '')

  fs.writeFileSync(cliJsPath, `
const fs = require('fs');
const path = require('path');
const callsPath = ${JSON.stringify(callsPath)};
const args = process.argv.slice(2);
fs.appendFileSync(callsPath, args.join(' ') + '\\n');
const cmd = args[0] || '';
${extraJs}
if (cmd === 'auto') {
  process.stdout.write(${JSON.stringify(onAuto)} + (String(${JSON.stringify(onAuto)}).endsWith('\\n') ? '' : '\\n'));
} else if (cmd === 'open') {
  process.stdout.write(${JSON.stringify(onOpen)} + (String(${JSON.stringify(onOpen)}).endsWith('\\n') ? '' : '\\n'));
} else if (cmd === 'close') {
  process.stdout.write(${JSON.stringify(onClose)} + (String(${JSON.stringify(onClose)}).endsWith('\\n') ? '' : '\\n'));
}
process.exit(${alwaysExit});
`)

  const cliBatPath = path.join(dir, 'cli.bat')
  fs.writeFileSync(cliBatPath, `@echo off\r
node "%~dp0cli.js" %*\r
`)

  // WSL 测试保留旧 bundle 入口，避免依赖 Windows 侧另装 Node。
  const nodeExePath = path.join(dir, 'node.exe')
  if (process.platform === 'win32') {
    try {
      fs.linkSync(process.execPath, nodeExePath)
    } catch (_) {
      fs.copyFileSync(process.execPath, nodeExePath)
    }
  } else {
    fs.writeFileSync(nodeExePath, `#!/bin/sh
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# 丢弃 Windows 形态的 cli.js 参数，改用本地 cli.js
shift
exec ${JSON.stringify(process.execPath)} "$DIR/cli.js" "$@"
`)
    fs.chmodSync(nodeExePath, 0o755)
  }

  // 非 win32 host 直接执行 cliPath 时也可用
  const shellCliPath = path.join(dir, 'cli')
  fs.writeFileSync(shellCliPath, `#!/bin/sh
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec ${JSON.stringify(process.execPath)} "$DIR/cli.js" "$@"
`)
  fs.chmodSync(shellCliPath, 0o755)

  return {
    dir,
    callsPath,
    /** Windows 使用 cli.bat，WSL 使用旧 bundle，macOS/裸 Linux 使用 wrapper。 */
    cliPath: process.platform === 'win32' ? cliBatPath : (isWslRuntime() ? cliJsPath : shellCliPath),
    readCalls() {
      if (!fs.existsSync(callsPath)) {
        return []
      }
      return fs.readFileSync(callsPath, 'utf8').trim().split(/\r?\n/u).filter(Boolean)
    },
  }
}

async function withHome(homeDir, fn) {
  const previousHome = process.env.HOME
  const previousUserProfile = process.env.USERPROFILE
  process.env.HOME = homeDir
  process.env.USERPROFILE = homeDir
  try {
    return await fn()
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = previousHome
    }
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE
    } else {
      process.env.USERPROFILE = previousUserProfile
    }
  }
}

/** 不依赖 open 成功；写入可被 session list/kill 发现的 session 文件 */
async function seedSession(homeDir, { name, projectPath, autoPort = '', devtoolsPort = '', cliPath: sessionCliPath = '', devtoolsProjectPath = '' }) {
  return withHome(homeDir, async () => {
    const state = createEmptySessionState({
      sessionName: name,
      config: {
        ...createDefaultConfig(),
        projectPath,
        autoPort,
        devtoolsPort,
        cliPath: sessionCliPath,
        devtoolsProjectPath,
      },
    })
    await saveSessionState(state)
    if (autoPort) {
      await recordRuntimeLaunch(name, {
        ...createDefaultConfig(),
        projectPath,
        autoPort,
        devtoolsPort,
        cliPath: sessionCliPath,
        devtoolsProjectPath,
      }, {
        status: 'live',
        autoPort,
        devtoolsPort,
      })
    }
    return state
  })
}

test('CLI emits JSON errors when --json is present on argument errors', () => {
  const result = runCli(['open', '--session', '--json'])
  const payload = parseJsonOutput(result)

  assert.notEqual(result.status, 0)
  assert.equal(payload.ok, false)
  assert.equal(payload.error.code, 'CLI_USAGE_ERROR')
  assert.match(payload.error.message, /--session.*value|--session.*值/i)
})

test('session list includes createdAt for seeded sessions', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-home-'))
  const projectDir = createMiniProgramProject()
  await seedSession(homeDir, { name: 'timed', projectPath: projectDir })

  const result = runCli(['session', 'list', '--json'], { HOME: homeDir }, { cwd: projectDir })
  const payload = parseJsonOutput(result)
  assert.equal(result.status, 0)
  assert.equal(payload.sessions.length, 1)
  assert.equal(payload.sessions[0].name, 'timed')
  assert.match(String(payload.sessions[0].createdAt || ''), /^\d{4}-\d{2}-\d{2}T/)
})

test('status and session info expose the active session without starting a runtime', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-home-'))
  const projectDir = createMiniProgramProject()
  await seedSession(homeDir, { name: 'timed', projectPath: projectDir })
  await withHome(homeDir, async () => {
    await setActiveSession('timed', {
      ...createDefaultConfig(),
      projectPath: projectDir,
    })
  })

  const status = runCli(['status', '--json'], { HOME: homeDir }, { cwd: projectDir })
  const statusPayload = parseJsonOutput(status)
  assert.equal(status.status, 0)
  assert.equal(statusPayload.session, 'timed')
  assert.equal(statusPayload.active, true)
  assert.equal(statusPayload.status, 'stale')
  assert.equal(statusPayload.runtime, 'none')

  const list = runCli(['session', 'list', '--json'], { HOME: homeDir }, { cwd: projectDir })
  const listPayload = parseJsonOutput(list)
  assert.equal(list.status, 0)
  assert.equal(listPayload.sessions[0].active, true)

  const info = runCli(['session', 'info', 'timed', '--json'], { HOME: homeDir }, { cwd: projectDir })
  const infoPayload = parseJsonOutput(info)
  assert.equal(info.status, 0)
  assert.equal(infoPayload.selection, 'explicit')
  assert.equal(infoPayload.session, 'timed')
})

test('session list backfills autoPort for attached session from project live launch', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-home-'))
  const projectDir = createMiniProgramProject()

  // owner 持有 live launch；attached 会话无自身 launch 行（真实 open attach 后常见）
  await seedSession(homeDir, {
    name: 'owner-work',
    projectPath: projectDir,
    autoPort: '19566',
  })
  await withHome(homeDir, async () => {
    const attached = createEmptySessionState({
      sessionName: 'attached-x1',
      config: {
        ...createDefaultConfig(),
        projectPath: projectDir,
      },
    })
    attached.runtimeAttached = true
    attached.runtimeOwnerSession = 'owner-work'
    await saveSessionState(attached)
  })

  const result = runCli(['session', 'list', '--json'], { HOME: homeDir }, { cwd: projectDir })
  const payload = parseJsonOutput(result)
  assert.equal(result.status, 0)
  const byName = Object.fromEntries((payload.sessions || []).map((s) => [s.name, s]))
  assert.ok(byName['attached-x1'], payload)
  assert.equal(byName['attached-x1'].autoPort, '19566')
  assert.equal(byName['attached-x1'].attachedTo || byName['attached-x1'].runtimeOwnerSession, 'owner-work')
  // 无真实 endpoint 时 status 仍为 stale，但 autoPort 必须回填（观测可用）
  assert.ok(byName['owner-work'])
  assert.equal(byName['owner-work'].autoPort, '19566')
})

test('non-open commands do not invent a fake autoPort when runtime is unbound', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-home-'))
  const projectDir = createMiniProgramProject()
  // session 存在但无 live launch、无 autoPort
  await seedSession(homeDir, { name: 'orphan', projectPath: projectDir })

  const result = runCli([
    'path',
    '--session',
    'orphan',
    '--project',
    projectDir,
    '--json',
  ], { HOME: homeDir })
  const payload = parseJsonOutput(result)
  assert.notEqual(result.status, 0)
  const msg = String((payload.error && payload.error.message) || '')
  // 应提示先 open，而不是「记录的 autoPort=95xx 当前不可用」
  assert.match(msg, /自动化未连接|请先执行 open/i)
  assert.doesNotMatch(msg, /记录的 autoPort=\d+/)
})

test('session list hides ephemeral gate/e2e stale noise by default', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-home-'))
  const projectDir = createMiniProgramProject()
  await seedSession(homeDir, { name: 'work', projectPath: projectDir, autoPort: '19501' })
  await seedSession(homeDir, { name: 'gate-abc123', projectPath: projectDir, autoPort: '19502' })
  await seedSession(homeDir, { name: 'e2e-a-xyz', projectPath: projectDir })
  await seedSession(homeDir, { name: 'test-real', projectPath: projectDir })

  const defaultList = runCli(['session', 'list', '--json'], { HOME: homeDir }, { cwd: projectDir })
  const defaultPayload = parseJsonOutput(defaultList)
  assert.equal(defaultList.status, 0)
  const defaultNames = (defaultPayload.sessions || []).map((s) => s.name).sort()
  assert.deepEqual(defaultNames, ['work'])
  assert.ok(Number(defaultPayload.hiddenNoise || 0) >= 2)

  const noisy = runCli(['session', 'list', '--json', '--noise'], { HOME: homeDir }, { cwd: projectDir })
  const noisyPayload = parseJsonOutput(noisy)
  const noisyNames = (noisyPayload.sessions || []).map((s) => s.name).sort()
  assert.deepEqual(noisyNames, ['e2e-a-xyz', 'gate-abc123', 'test-real', 'work'])
})

test('session list filters to the current mini program project unless --all is passed', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-home-'))
  const projectA = createMiniProgramProject()
  const projectB = createMiniProgramProject()
  await seedSession(homeDir, { name: 'project-a', projectPath: projectA })
  await seedSession(homeDir, { name: 'project-b', projectPath: projectB })

  const currentProjectResult = runCli(['session', 'list', '--json'], { HOME: homeDir }, { cwd: projectA })
  const currentProjectPayload = parseJsonOutput(currentProjectResult)
  assert.equal(currentProjectResult.status, 0)
  assert.deepEqual(currentProjectPayload.sessions.map((item) => item.name), ['project-a'])

  const allResult = runCli(['session', 'list', '--json', '--all'], { HOME: homeDir }, { cwd: projectA })
  const allPayload = parseJsonOutput(allResult)
  assert.equal(allResult.status, 0)
  assert.deepEqual(allPayload.sessions.map((item) => item.name).sort(), ['project-a', 'project-b'])
})

test('session list does not leak global sessions outside a mini program project by default', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-home-'))
  const projectA = createMiniProgramProject()
  const projectB = createMiniProgramProject()
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-outside-'))
  await seedSession(homeDir, { name: 'project-a', projectPath: projectA })
  await seedSession(homeDir, { name: 'project-b', projectPath: projectB })

  const scopedResult = runCli(['session', 'list', '--json'], { HOME: homeDir }, { cwd: outsideDir })
  const scopedPayload = parseJsonOutput(scopedResult)
  assert.equal(scopedResult.status, 0)
  assert.deepEqual(scopedPayload.sessions, [])
  assert.match(scopedPayload.message, /当前目录|--project|--all/i)

  const allResult = runCli(['session', 'list', '--json', '--all'], { HOME: homeDir }, { cwd: outsideDir })
  const allPayload = parseJsonOutput(allResult)
  assert.equal(allResult.status, 0)
  assert.deepEqual(allPayload.sessions.map((item) => item.name).sort(), ['project-a', 'project-b'])
})

test('session kill uses the current project when the same session name exists in multiple projects', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-home-'))
  const projectA = createMiniProgramProject()
  const projectB = createMiniProgramProject()
  await seedSession(homeDir, { name: 'shared', projectPath: projectA })
  await seedSession(homeDir, { name: 'shared', projectPath: projectB })

  const killResult = runCli(['session', 'kill', 'shared', '--json'], { HOME: homeDir }, { cwd: projectA })
  const killPayload = parseJsonOutput(killResult)
  assert.equal(killResult.status, 0)
  assert.match(killPayload.message, /shared/)

  const projectAResult = runCli(['session', 'list', '--json'], { HOME: homeDir }, { cwd: projectA })
  const projectAPayload = parseJsonOutput(projectAResult)
  assert.deepEqual(projectAPayload.sessions, [])

  const projectBResult = runCli(['session', 'list', '--json'], { HOME: homeDir }, { cwd: projectB })
  const projectBPayload = parseJsonOutput(projectBResult)
  assert.deepEqual(projectBPayload.sessions.map((item) => item.name), ['shared'])
})

test('session kill waits on the shared runtime lock before closing a runtime', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-home-'))
  const projectDir = createMiniProgramProject()
  let runtimeLock = null

  try {
    await seedSession(homeDir, {
      name: 'owner',
      projectPath: projectDir,
      autoPort: '19515',
      devtoolsPort: '29515',
    })

    await withHome(homeDir, async () => {
      const ownerState = await loadSessionState(
        'owner',
        mergeConfigOverrides(createDefaultConfig(), { projectPath: projectDir }),
      )
      // load 会 strip autoPort；从 launch 记录回填以测 runtime 锁
      if (!ownerState.config.autoPort) {
        ownerState.config.autoPort = '19515'
      }
      assert.ok(ownerState.config.autoPort)
      runtimeLock = await acquireSessionLock(runtimeLockName(ownerState.config), ownerState.config, {
        command: 'runtime path',
        timeoutMs: 100,
      })
    })

    const killResult = runCli(['session', 'kill', 'owner', '--json'], {
      HOME: homeDir,
      MINIPROGRAM_BROWSER_LOCK_TIMEOUT_MS: '150',
      MINIPROGRAM_BROWSER_LOCK_STALE_MS: '600000',
    }, { cwd: projectDir })
    const killPayload = parseJsonOutput(killResult)

    assert.notEqual(killResult.status, 0)
    assert.equal(killPayload.ok, false)
    assert.match(killPayload.error.message, /Session is busy|runtime path/i)
  } finally {
    if (runtimeLock) {
      await releaseSessionLock(runtimeLock)
    }
    runCli(['session', 'kill', 'owner', '--json'], { HOME: homeDir }, { cwd: projectDir })
  }
})

test('open discovers the mini program project from the current Git worktree', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-git-repo-'))
  const projectDir = createMiniProgramProjectAt(path.join(repoDir, 'apps', 'miniprogram'))
  const backendDir = path.join(repoDir, 'apps', 'backend', 'src')
  fs.mkdirSync(path.join(repoDir, '.git'), { recursive: true })
  fs.mkdirSync(backendDir, { recursive: true })

  const result = runCli(['open', '--session', 'discovered-project', '--json'], {}, { cwd: backendDir })
  const payload = parseJsonOutput(result)

  assert.notEqual(result.status, 0)
  assert.equal(payload.ok, false)
  assert.match(payload.error.message, /WECHAT_DEVTOOLS_CLI|DevTools CLI/i)
  assert.equal(payload.error.diagnostics.projectPath, fs.realpathSync(projectDir))
  assert.doesNotMatch(payload.error.message, /Missing project path|--project <miniprogram-root>/i)
})

test('app inspect can run as a static project inspection without DevTools automation', () => {
  const projectDir = createMiniProgramProject()
  const result = runCli(['app', 'inspect', '--session', 'static-inspect-test', '--project', projectDir, '--json'])
  const payload = parseJsonOutput(result)

  assert.equal(result.status, 0)
  assert.equal(payload.pagesSummary.count, 1)
  assert.equal(payload.pagesSummary.entryPagePath, 'pages/index/index')
  assert.equal(payload.staticSummary.hasNavigateTo, true)
})

test('logs for an unbound session fails instead of returning an empty success result', () => {
  const result = runCli(['logs', '--session', 'no-such-session', '--json'])
  const payload = parseJsonOutput(result)

  assert.notEqual(result.status, 0)
  assert.equal(payload.ok, false)
  assert.match(payload.error.message, /Session not found|未绑定|open/i)
})

test('open validates the project shape before starting DevTools automation', () => {
  const invalidProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-invalid-project-'))
  const result = runCli(['open', '--session', 'bad-project', '--project', invalidProjectDir, '--json'])
  const payload = parseJsonOutput(result)

  assert.notEqual(result.status, 0)
  assert.equal(payload.ok, false)
  assert.match(payload.error.message, /project\.config\.json|app\.json|小程序项目/i)
})

test('open reports missing DevTools CLI path before WebSocket connection attempts', () => {
  const projectDir = createMiniProgramProject()
  const result = runCli(['open', '--session', 'missing-cli', '--project', projectDir, '--json'])
  const payload = parseJsonOutput(result)

  assert.notEqual(result.status, 0)
  assert.equal(payload.ok, false)
  assert.match(payload.error.message, /WECHAT_DEVTOOLS_CLI|--cli-path|DevTools CLI/i)
  assert.doesNotMatch(payload.error.message, /ws:\/\/127\.0\.0\.1/i)
})

test('open reports invalid DevTools CLI paths clearly', () => {
  const projectDir = createMiniProgramProject()
  const result = runCli([
    'open',
    '--session',
    'invalid-cli',
    '--project',
    projectDir,
    '--cli-path',
    '/tmp/not-a-devtools-cli',
    '--json',
  ])
  const payload = parseJsonOutput(result)

  assert.notEqual(result.status, 0)
  assert.equal(payload.ok, false)
  assert.match(payload.error.message, /not found|不存在|DevTools CLI/i)
  assert.notEqual(payload.error.message.trim(), '')
})

test('open treats DevTools code 17 output as fatal even when CLI exits zero', () => {
  const projectDir = createMiniProgramProject()
  const fake = createFakeDevtoolsCli({
    onAuto: [
      '× preparing',
      '[error] code: 17',
      '二维码输出路径无效或不存在',
      'QR_PATH_NOT_VALID_OR_NOT_EXIST',
    ].join('\n'),
    alwaysExit: 0,
  })

  const result = runCli([
    'open',
    '--session',
    'code17-cli',
    '--project',
    projectDir,
    '--cli-path',
    fake.cliPath,
    '--json',
  ])
  const payload = parseJsonOutput(result)

  assert.notEqual(result.status, 0)
  assert.equal(payload.ok, false)
  assert.equal(payload.error.code, 'DEVTOOLS_CLI_ERROR')
  assert.match(payload.error.message, /code 17|QR_PATH_NOT_VALID_OR_NOT_EXIST|--devtools-project/i)
  assert.match(String(payload.error.hint || ''), /code 17|QR_PATH_NOT_VALID_OR_NOT_EXIST|二维码/i)
  assert.match(String(payload.error.raw || ''), /二维码输出路径无效或不存在/)
  assert.doesNotMatch(payload.error.message, /ws:\/\/127\.0\.0\.1/i)
})

test('open bounds startup with --timeout and returns JSON diagnostics', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-home-'))
  const projectDir = createMiniProgramProject()
  const fake = createFakeDevtoolsCli({
    onAuto: '✔ IDE server has started, listening on http://127.0.0.1:38596',
  })

  const startedAt = Date.now()
  const result = runCli([
    'open',
    '--session',
    'startup-timeout',
    '--project',
    projectDir,
    '--cli-path',
    fake.cliPath,
    '--timeout',
    '200',
    '--json',
  ], { HOME: homeDir })
  const elapsedMs = Date.now() - startedAt
  const payload = parseJsonOutput(result)

  assert.notEqual(result.status, 0)
  assert.equal(payload.ok, false)
  assert.equal(payload.error.code, 'OPEN_TIMEOUT')
  assert.match(payload.error.message, /open timed out after 200ms|冷启动未完成|automation WebSocket/i)
  assert.match(String(payload.error.hint || ''), /resolution=start-required/i)
  assert.ok(elapsedMs < 3000, `open timeout should not wait for full retry loop, elapsed=${elapsedMs}`)
})

test('open reports adopt/bootstrap resolution when reusing an explicit DevTools HTTP port', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-home-'))
  const projectDir = createMiniProgramProject()
  const fake = createFakeDevtoolsCli({
    onAuto: '✔ IDE server has started, listening on http://127.0.0.1:23986',
  })

  const result = runCli([
    'open',
    '--session',
    'adopt-open',
    '--project',
    projectDir,
    '--devtools-port',
    '23986',
    '--cli-path',
    fake.cliPath,
    '--timeout',
    '200',
    '--json',
  ], { HOME: homeDir })
  const payload = parseJsonOutput(result)

  assert.notEqual(result.status, 0)
  assert.equal(payload.ok, false)
  assert.match(String(payload.error.hint || ''), /resolution=adopt-via-devtools-port/i)
  assert.equal(payload.error.diagnostics.devtoolsPort, '23986')
  assert.equal(payload.error.diagnostics.cleanup.sessionCleared, true)
})

test('open closes a newly-started DevTools project when startup times out', () => {
  const projectDir = createMiniProgramProject()
  const fake = createFakeDevtoolsCli({
    onAuto: '✔ IDE server has started, listening on http://127.0.0.1:38596',
    onClose: '✔ close',
  })

  const result = runCli([
    'open',
    '--session',
    'startup-cleanup-timeout',
    '--project',
    projectDir,
    '--cli-path',
    fake.cliPath,
    '--timeout',
    '3000',
    '--json',
  ])
  const payload = parseJsonOutput(result)
  const calls = fake.readCalls()

  assert.notEqual(result.status, 0)
  assert.equal(payload.error.code, 'OPEN_TIMEOUT')
  const failureContext = `${calls.join('\n')}\n${JSON.stringify(payload, null, 2)}`
  assert.ok(calls.some((line) => /^auto --project /u.test(line)), failureContext)
  assert.ok(calls.some((line) => /^close --project /u.test(line)), failureContext)
  assert.equal(payload.error.diagnostics.cleanup.projectClosed, true)
})

test('doctor can probe a DevTools HTTP port without a prebound session and does not persist one', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-home-'))
  const projectDir = createMiniProgramProject()
  const fake = createFakeDevtoolsCli({
    onAuto: '✔ IDE server has started, listening on http://127.0.0.1:23986',
  })

  const result = runCli([
    'doctor',
    '--project',
    projectDir,
    '--devtools-port',
    '23986',
    '--cli-path',
    fake.cliPath,
    '--wait',
    '0',
    '--timeout',
    '2000',
    '--json',
  ], { HOME: homeDir })
  const payload = parseJsonOutput(result)
  const calls = fake.readCalls()

  assert.equal(result.status, 0)
  assert.equal(payload.ok, false)
  assert.equal(payload.projectPath, projectDir)
  assert.equal(payload.devtoolsPort, '23986')
  assert.ok(payload.probe, JSON.stringify(payload, null, 2))
  assert.equal(payload.probe.connected, false)
  // endpoint 未 live 时 doctor 仍会 enableAutomation(openFirst=false)，只跑 auto，不强制 open
  assert.ok(calls.some((line) => /^auto --project /u.test(line)), calls.join('\n'))

  const listResult = runCli(['session', 'list', '--json'], { HOME: homeDir }, { cwd: projectDir })
  const listPayload = parseJsonOutput(listResult)
  assert.deepEqual(listPayload.sessions, [])
})

test('doctor still enables automation when bound autoPort is not live', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-home-'))
  const projectDir = createMiniProgramProject()
  const fake = createFakeDevtoolsCli({
    onAuto: '✔ IDE server has started, listening on http://127.0.0.1:23987',
  })

  // 不可达 port：live-first 探测失败后仍应 enable（回归保护）。
  // 已 live 跳过 enable 的路径见真机复核 / 后续 automator mock。
  await seedSession(homeDir, {
    name: 'doc-stale',
    projectPath: projectDir,
    autoPort: '19999',
    cliPath: fake.cliPath,
  })

  const result = runCli([
    'doctor',
    '--session',
    'doc-stale',
    '--project',
    projectDir,
    '--cli-path',
    fake.cliPath,
    '--wait',
    '0',
    '--timeout',
    '1500',
    '--json',
  ], { HOME: homeDir })
  const payload = parseJsonOutput(result)
  const calls = fake.readCalls()

  assert.equal(result.status, 0)
  assert.equal(payload.ok, false)
  assert.ok(calls.some((line) => /^auto --project /u.test(line)), calls.join('\n'))
  assert.equal(payload.projectPath, projectDir)
  assert.notEqual(payload.automation && payload.automation.reusedLive, true)
})

test('doctor bounds a hanging DevTools CLI with its timeout budget', () => {
  const projectDir = createMiniProgramProject()
  const fake = createFakeDevtoolsCli({
    extraJs: "if (cmd === 'auto') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);",
  })
  const startedAt = Date.now()

  const result = runCli([
    'doctor',
    '--project',
    projectDir,
    '--devtools-port',
    '23988',
    '--cli-path',
    fake.cliPath,
    '--wait',
    '0',
    '--timeout',
    '200',
    '--json',
  ])
  const elapsedMs = Date.now() - startedAt
  const payload = parseJsonOutput(result)

  assert.equal(result.status, 0)
  assert.equal(payload.ok, false)
  assert.equal(payload.probe, null)
  assert.match(payload.automation.error.message, /timed out|ETIMEDOUT|timeout/i)
  assert.ok(elapsedMs < 2000, `doctor timeout should bound the synchronous DevTools CLI, elapsed=${elapsedMs}`)
})

test('session prune closes and removes stale sessions only for the current project', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-home-'))
  const projectDir = createMiniProgramProject()
  const otherProjectDir = createMiniProgramProject()
  const fake = createFakeDevtoolsCli({ onClose: '✔ close' })

  await seedSession(homeDir, {
    name: 'stale-owned',
    projectPath: projectDir,
    cliPath: fake.cliPath,
    autoPort: '18181',
    devtoolsPort: '24880',
    devtoolsProjectPath: 'C:\\Users\\tester\\AppData\\Local\\Temp\\miniprogram-browser\\project-stale-owned',
  })
  await seedSession(homeDir, {
    name: 'other-project-stale',
    projectPath: otherProjectDir,
    cliPath: fake.cliPath,
    autoPort: '18182',
    devtoolsPort: '24880',
    devtoolsProjectPath: 'C:\\Users\\tester\\AppData\\Local\\Temp\\miniprogram-browser\\project-other-stale',
  })

  const result = runCli(['session', 'prune', '--json'], { HOME: homeDir }, { cwd: projectDir })
  const payload = parseJsonOutput(result)
  const calls = fake.readCalls()

  assert.equal(result.status, 0)
  assert.deepEqual(payload.pruned.map((item) => item.name), ['stale-owned'])
  assert.ok(calls.some((line) => /project-stale-owned/u.test(line)), calls.join('\n'))
  assert.ok(!calls.some((line) => /project-other-stale/u.test(line)), calls.join('\n'))

  const currentProjectResult = runCli(['session', 'list', '--json'], { HOME: homeDir }, { cwd: projectDir })
  assert.deepEqual(parseJsonOutput(currentProjectResult).sessions, [])
  const otherProjectResult = runCli(['session', 'list', '--json'], { HOME: homeDir }, { cwd: otherProjectDir })
  assert.deepEqual(parseJsonOutput(otherProjectResult).sessions.map((item) => item.name), ['other-project-stale'])
})

test('session prune closes project-scoped orphan launch records', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-home-'))
  const projectDir = createMiniProgramProject()
  const otherProjectDir = createMiniProgramProject()
  const fake = createFakeDevtoolsCli({ onClose: '✔ close' })

  await withHome(homeDir, async () => {
    await recordRuntimeLaunch('orphan-launch', {
      ...createDefaultConfig(),
      projectPath: projectDir,
      cliPath: fake.cliPath,
      autoPort: '18183',
      devtoolsPort: '24880',
      devtoolsProjectPath: 'C:\\Users\\tester\\AppData\\Local\\Temp\\miniprogram-browser\\project-orphan-launch',
    }, {
      id: 'launch-orphan',
      projectStrategy: 'managed-mirror',
      status: 'starting',
    })
    await recordRuntimeLaunch('other-orphan-launch', {
      ...createDefaultConfig(),
      projectPath: otherProjectDir,
      cliPath: fake.cliPath,
      autoPort: '18184',
      devtoolsPort: '24880',
      devtoolsProjectPath: 'C:\\Users\\tester\\AppData\\Local\\Temp\\miniprogram-browser\\project-other-orphan',
    }, {
      id: 'launch-other-orphan',
      projectStrategy: 'managed-mirror',
      status: 'starting',
    })
  })

  const result = runCli(['session', 'prune', '--json'], { HOME: homeDir }, { cwd: projectDir })
  const payload = parseJsonOutput(result)
  const calls = fake.readCalls()

  assert.equal(result.status, 0)
  assert.deepEqual(payload.launchesPruned.map((item) => item.id), ['launch-orphan'])
  assert.ok(calls.some((line) => /project-orphan-launch/u.test(line)), calls.join('\n'))
  assert.ok(!calls.some((line) => /project-other-orphan/u.test(line)), calls.join('\n'))

  await withHome(homeDir, async () => {
    assert.deepEqual(
      (await listRuntimeLaunches({ ...createDefaultConfig(), projectPath: projectDir })).map((item) => item.id),
      [],
    )
    assert.deepEqual(
      (await listRuntimeLaunches({ ...createDefaultConfig(), projectPath: otherProjectDir })).map((item) => item.id),
      ['launch-other-orphan'],
    )
  })
})
