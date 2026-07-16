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
} = require('../dist/lib/session-store.js')

const repoRoot = path.resolve(__dirname, '..')
const cliPath = path.join(repoRoot, 'dist/miniprogram-browser.js')

function runCli(args, env = {}, options = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: options.cwd || repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-home-')),
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

function createMiniProgramProject() {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-project-'))
  const miniprogramRoot = path.join(projectDir, 'miniprogram')
  fs.mkdirSync(path.join(miniprogramRoot, 'pages/index'), { recursive: true })
  fs.writeFileSync(path.join(projectDir, 'project.config.json'), JSON.stringify({ miniprogramRoot: 'miniprogram/' }))
  fs.writeFileSync(path.join(miniprogramRoot, 'app.json'), JSON.stringify({ pages: ['pages/index/index'] }))
  fs.writeFileSync(path.join(miniprogramRoot, 'pages/index/index.js'), 'wx.navigateTo({ url: "/pages/detail/index" })')
  return projectDir
}

function createMiniProgramProjectAt(projectDir) {
  const miniprogramRoot = path.join(projectDir, 'miniprogram')
  fs.mkdirSync(path.join(miniprogramRoot, 'pages/index'), { recursive: true })
  fs.writeFileSync(path.join(projectDir, 'project.config.json'), JSON.stringify({ miniprogramRoot: 'miniprogram/' }))
  fs.writeFileSync(path.join(miniprogramRoot, 'app.json'), JSON.stringify({ pages: ['pages/index/index'] }))
  fs.writeFileSync(path.join(miniprogramRoot, 'pages/index/index.js'), 'wx.navigateTo({ url: "/pages/detail/index" })')
  return projectDir
}

test('CLI emits JSON errors when --json is present on argument errors', () => {
  const result = runCli(['open', '--session', '--json'])
  const payload = parseJsonOutput(result)

  assert.notEqual(result.status, 0)
  assert.equal(payload.ok, false)
  assert.equal(payload.error.code, 'CLI_USAGE_ERROR')
  assert.match(payload.error.message, /--session.*value|--session.*值/i)
})

test('session list filters to the current mini program project unless --all is passed', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-home-'))
  const projectA = createMiniProgramProject()
  const projectB = createMiniProgramProject()
  runCli(['open', '--session', 'project-a', '--project', projectA, '--json'], { HOME: homeDir })
  runCli(['open', '--session', 'project-b', '--project', projectB, '--json'], { HOME: homeDir })

  const currentProjectResult = runCli(['session', 'list', '--json'], { HOME: homeDir }, { cwd: projectA })
  const currentProjectPayload = parseJsonOutput(currentProjectResult)
  assert.equal(currentProjectResult.status, 0)
  assert.deepEqual(currentProjectPayload.sessions.map((item) => item.name), ['project-a'])

  const allResult = runCli(['session', 'list', '--json', '--all'], { HOME: homeDir }, { cwd: projectA })
  const allPayload = parseJsonOutput(allResult)
  assert.equal(allResult.status, 0)
  assert.deepEqual(allPayload.sessions.map((item) => item.name).sort(), ['project-a', 'project-b'])
})

test('session list does not leak global sessions outside a mini program project by default', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-home-'))
  const projectA = createMiniProgramProject()
  const projectB = createMiniProgramProject()
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-outside-'))
  runCli(['open', '--session', 'project-a', '--project', projectA, '--json'], { HOME: homeDir })
  runCli(['open', '--session', 'project-b', '--project', projectB, '--json'], { HOME: homeDir })

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

test('session kill uses the current project when the same session name exists in multiple projects', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-home-'))
  const projectA = createMiniProgramProject()
  const projectB = createMiniProgramProject()
  runCli(['open', '--session', 'shared', '--project', projectA, '--json'], { HOME: homeDir })
  const secondOpenResult = runCli(['open', '--session', 'shared', '--project', projectB, '--json'], { HOME: homeDir })
  const secondOpenPayload = parseJsonOutput(secondOpenResult)
  assert.doesNotMatch(secondOpenPayload.error.message, /already bound/i)

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
  const previousHome = process.env.HOME
  let runtimeLock = null

  try {
    runCli(['open', '--session', 'owner', '--project', projectDir, '--json'], { HOME: homeDir })
    process.env.HOME = homeDir
    const ownerState = await loadSessionState(
      'owner',
      mergeConfigOverrides(createDefaultConfig(), { projectPath: projectDir }),
    )
    assert.ok(ownerState.config.autoPort)
    runtimeLock = await acquireSessionLock(runtimeLockName(ownerState.config), ownerState.config, {
      command: 'runtime path',
      timeoutMs: 100,
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
    if (previousHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = previousHome
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
  assert.equal(payload.error.diagnostics.projectPath, projectDir)
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
  const fakeCliPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-fake-cli-')), 'cli')
  fs.writeFileSync(fakeCliPath, [
    '#!/bin/sh',
    'echo "× preparing"',
    'echo "[error] code: 17"',
    'echo "二维码输出路径无效或不存在"',
    'echo "QR_PATH_NOT_VALID_OR_NOT_EXIST"',
    'exit 0',
  ].join('\n'))
  fs.chmodSync(fakeCliPath, 0o755)

  const result = runCli([
    'open',
    '--session',
    'code17-cli',
    '--project',
    projectDir,
    '--cli-path',
    fakeCliPath,
    '--json',
  ])
  const payload = parseJsonOutput(result)

  assert.notEqual(result.status, 0)
  assert.equal(payload.ok, false)
  assert.equal(payload.error.code, 'DEVTOOLS_CLI_ERROR')
  assert.match(payload.error.message, /code 17|QR_PATH_NOT_VALID_OR_NOT_EXIST|--devtools-project/i)
  assert.match(payload.error.hint, /code 17|QR_PATH_NOT_VALID_OR_NOT_EXIST|二维码/i)
  assert.match(payload.error.raw, /二维码输出路径无效或不存在/)
  assert.doesNotMatch(payload.error.message, /ws:\/\/127\.0\.0\.1/i)
})

test('open bounds startup with --timeout and returns JSON diagnostics', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-home-'))
  const projectDir = createMiniProgramProject()
  const fakeCliPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-fake-slow-cli-')), 'cli')
  fs.writeFileSync(fakeCliPath, [
    '#!/bin/sh',
    'echo "✔ IDE server has started, listening on http://127.0.0.1:38596"',
    'exit 0',
  ].join('\n'))
  fs.chmodSync(fakeCliPath, 0o755)

  const startedAt = Date.now()
  const result = runCli([
    'open',
    '--session',
    'startup-timeout',
    '--project',
    projectDir,
    '--cli-path',
    fakeCliPath,
    '--timeout',
    '200',
    '--json',
  ], { HOME: homeDir })
  const elapsedMs = Date.now() - startedAt
  const payload = parseJsonOutput(result)

  assert.notEqual(result.status, 0)
  assert.equal(payload.ok, false)
  assert.equal(payload.error.code, 'OPEN_TIMEOUT')
  assert.match(payload.error.message, /open timed out after 200ms/i)
  assert.match(payload.error.hint, /resolution=start-required/i)
  assert.ok(elapsedMs < 3000, `open timeout should not wait for full retry loop, elapsed=${elapsedMs}`)
})

test('open reports adopt/bootstrap resolution when reusing an explicit DevTools HTTP port', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-home-'))
  const projectDir = createMiniProgramProject()
  const fakeCliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-fake-adopt-open-cli-'))
  const callsPath = path.join(fakeCliDir, 'calls.log')
  const fakeCliPath = path.join(fakeCliDir, 'cli')
  fs.writeFileSync(fakeCliPath, [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> ${JSON.stringify(callsPath)}`,
    'if [ "$1" = "auto" ]; then echo "✔ IDE server has started, listening on http://127.0.0.1:23986"; fi',
    'exit 0',
  ].join('\n'))
  fs.chmodSync(fakeCliPath, 0o755)

  const result = runCli([
    'open',
    '--session',
    'adopt-open',
    '--project',
    projectDir,
    '--devtools-port',
    '23986',
    '--cli-path',
    fakeCliPath,
    '--timeout',
    '200',
    '--json',
  ], { HOME: homeDir })
  const payload = parseJsonOutput(result)

  assert.notEqual(result.status, 0)
  assert.equal(payload.ok, false)
  assert.match(payload.error.hint, /resolution=adopt-via-devtools-port/i)
  assert.equal(payload.error.diagnostics.devtoolsPort, '23986')
  assert.equal(payload.error.diagnostics.cleanup.sessionCleared, true)
})

test('open closes a newly-started DevTools project when startup times out', () => {
  const projectDir = createMiniProgramProject()
  const fakeCliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-fake-cleanup-cli-'))
  const callsPath = path.join(fakeCliDir, 'calls.log')
  const fakeCliPath = path.join(fakeCliDir, 'cli')
  fs.writeFileSync(fakeCliPath, [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> ${JSON.stringify(callsPath)}`,
    'if [ "$1" = "auto" ]; then echo "✔ IDE server has started, listening on http://127.0.0.1:38596"; fi',
    'if [ "$1" = "close" ]; then echo "✔ close"; fi',
    'exit 0',
  ].join('\n'))
  fs.chmodSync(fakeCliPath, 0o755)

  const result = runCli([
    'open',
    '--session',
    'startup-cleanup-timeout',
    '--project',
    projectDir,
    '--cli-path',
    fakeCliPath,
    '--timeout',
    '200',
    '--json',
  ])
  const payload = parseJsonOutput(result)
  const calls = fs.readFileSync(callsPath, 'utf8').trim().split(/\r?\n/u)

  assert.notEqual(result.status, 0)
  assert.equal(payload.error.code, 'OPEN_TIMEOUT')
  assert.ok(calls.some((line) => /^auto --project /u.test(line)), calls.join('\n'))
  assert.ok(calls.some((line) => /^close --project /u.test(line)), calls.join('\n'))
  assert.equal(payload.error.diagnostics.cleanup.projectClosed, true)
})

test('doctor can probe a DevTools HTTP port without a prebound session and does not persist one', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-home-'))
  const projectDir = createMiniProgramProject()
  const fakeCliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-fake-doctor-cli-'))
  const callsPath = path.join(fakeCliDir, 'calls.log')
  const fakeCliPath = path.join(fakeCliDir, 'cli')
  fs.writeFileSync(fakeCliPath, [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> ${JSON.stringify(callsPath)}`,
    'if [ "$1" = "auto" ]; then echo "✔ IDE server has started, listening on http://127.0.0.1:23986"; fi',
    'exit 0',
  ].join('\n'))
  fs.chmodSync(fakeCliPath, 0o755)

  const result = runCli([
    'doctor',
    '--project',
    projectDir,
    '--devtools-port',
    '23986',
    '--cli-path',
    fakeCliPath,
    '--wait',
    '0',
    '--timeout',
    '50',
    '--json',
  ], { HOME: homeDir })
  const payload = parseJsonOutput(result)
  const calls = fs.readFileSync(callsPath, 'utf8').trim().split(/\r?\n/u)

  assert.equal(result.status, 0)
  assert.equal(payload.projectPath, projectDir)
  assert.equal(payload.devtoolsPort, '23986')
  assert.equal(payload.probe.connected, false)
  assert.ok(calls.some((line) => /^open --project /u.test(line)), calls.join('\n'))
  assert.ok(calls.some((line) => /^auto --project /u.test(line)), calls.join('\n'))

  const listResult = runCli(['session', 'list', '--json'], { HOME: homeDir }, { cwd: projectDir })
  const listPayload = parseJsonOutput(listResult)
  assert.deepEqual(listPayload.sessions, [])
})

test('session prune closes and removes stale sessions only for the current project', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-home-'))
  const projectDir = createMiniProgramProject()
  const otherProjectDir = createMiniProgramProject()
  const fakeCliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-fake-prune-cli-'))
  const callsPath = path.join(fakeCliDir, 'calls.log')
  const fakeCliPath = path.join(fakeCliDir, 'cli')
  fs.writeFileSync(fakeCliPath, [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> ${JSON.stringify(callsPath)}`,
    'echo "✔ close"',
    'exit 0',
  ].join('\n'))
  fs.chmodSync(fakeCliPath, 0o755)

  const previousHome = process.env.HOME
  try {
    process.env.HOME = homeDir
    const staleState = createEmptySessionState({
      sessionName: 'stale-owned',
      config: {
        ...createDefaultConfig(),
        projectPath: projectDir,
        cliPath: fakeCliPath,
        autoPort: '18181',
        devtoolsPort: '24880',
        devtoolsProjectPath: 'C:\\Users\\tester\\AppData\\Local\\Temp\\miniprogram-browser\\project-stale-owned',
      },
    })
    const otherState = createEmptySessionState({
      sessionName: 'other-project-stale',
      config: {
        ...createDefaultConfig(),
        projectPath: otherProjectDir,
        cliPath: fakeCliPath,
        autoPort: '18182',
        devtoolsPort: '24880',
        devtoolsProjectPath: 'C:\\Users\\tester\\AppData\\Local\\Temp\\miniprogram-browser\\project-other-stale',
      },
    })
    await saveSessionState(staleState)
    await saveSessionState(otherState)
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = previousHome
    }
  }

  const result = runCli(['session', 'prune', '--json'], { HOME: homeDir }, { cwd: projectDir })
  const payload = parseJsonOutput(result)
  const calls = fs.readFileSync(callsPath, 'utf8').trim().split(/\r?\n/u)

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
  const fakeCliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-fake-launch-prune-cli-'))
  const callsPath = path.join(fakeCliDir, 'calls.log')
  const fakeCliPath = path.join(fakeCliDir, 'cli')
  fs.writeFileSync(fakeCliPath, [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> ${JSON.stringify(callsPath)}`,
    'echo "✔ close"',
    'exit 0',
  ].join('\n'))
  fs.chmodSync(fakeCliPath, 0o755)

  const previousHome = process.env.HOME
  try {
    process.env.HOME = homeDir
    await recordRuntimeLaunch('orphan-launch', {
      ...createDefaultConfig(),
      projectPath: projectDir,
      cliPath: fakeCliPath,
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
      cliPath: fakeCliPath,
      autoPort: '18184',
      devtoolsPort: '24880',
      devtoolsProjectPath: 'C:\\Users\\tester\\AppData\\Local\\Temp\\miniprogram-browser\\project-other-orphan',
    }, {
      id: 'launch-other-orphan',
      projectStrategy: 'managed-mirror',
      status: 'starting',
    })
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = previousHome
    }
  }

  const result = runCli(['session', 'prune', '--json'], { HOME: homeDir }, { cwd: projectDir })
  const payload = parseJsonOutput(result)
  const calls = fs.readFileSync(callsPath, 'utf8').trim().split(/\r?\n/u)

  assert.equal(result.status, 0)
  assert.deepEqual(payload.launchesPruned.map((item) => item.id), ['launch-orphan'])
  assert.ok(calls.some((line) => /project-orphan-launch/u.test(line)), calls.join('\n'))
  assert.ok(!calls.some((line) => /project-other-orphan/u.test(line)), calls.join('\n'))

  const previousHomeForRead = process.env.HOME
  try {
    process.env.HOME = homeDir
    assert.deepEqual(
      (await listRuntimeLaunches({ ...createDefaultConfig(), projectPath: projectDir })).map((item) => item.id),
      [],
    )
    assert.deepEqual(
      (await listRuntimeLaunches({ ...createDefaultConfig(), projectPath: otherProjectDir })).map((item) => item.id),
      ['launch-other-orphan'],
    )
  } finally {
    if (previousHomeForRead === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = previousHomeForRead
    }
  }
})
