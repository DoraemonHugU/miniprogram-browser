const test = require('node:test')
const assert = require('node:assert/strict')

const {
  buildHelpText,
  buildCommandHelpText,
  buildCliErrorPayload,
  getVersionText,
  normalizeOpenStableWaitError,
  parseArgs,
  parseFocusRefs,
  resolveOpenFailureNextAction,
  shouldRetryOpenWithAnotherAutoPort,
  summarizeOpenResolution,
  createMultipleLiveRuntimeError,
  summarizeDevtoolsStartupHints,
  classifyOpenFailureFromStartupHints,
  shouldAttemptVisualProbe,
  shouldEmitPreludeNotices,
  shouldClearFailedOpenSession,
  summarizeTimelinePayload,
  summarizeSnapshotPayload,
  attachFollowupPayload,
  isDoctorOk,
  resolveScreenshotMode,
  resolveSnapshotLayoutPolicy,
  resolveSnapshotTreeOptions,
  resolveActionWaitMs,
  performInputAndWait,
  waitForDoctorRuntimeProbe,
} = require('../dist/miniprogram-browser.js')

test('screenshot defaults to a real page image', () => {
  assert.equal(resolveScreenshotMode(undefined), 'page')
  assert.equal(resolveScreenshotMode('layout'), 'layout')
  assert.throws(() => resolveScreenshotMode('unknown'), /Unsupported screenshot mode/u)
})

test('doctor overall status requires both Tool and App runtime readiness', () => {
  assert.equal(isDoctorOk(null, { connected: true, appReady: true }), true)
  assert.equal(isDoctorOk(null, { connected: true, appReady: false }), false)
  assert.equal(isDoctorOk(null, { connected: false, appReady: false }), false)
  assert.equal(isDoctorOk({ message: 'enable failed' }, null), false)
})

test('doctor polls runtime state and returns as soon as the app is ready', async () => {
  let nowMs = 0
  const sleeps = []
  const probes = [
    { connected: true, appReady: false },
    { connected: true, appReady: true },
  ]

  const result = await waitForDoctorRuntimeProbe({}, {
    timeoutMs: 5000,
    pollMs: 200,
    nowFn: () => nowMs,
    sleepFn: async (ms) => {
      sleeps.push(ms)
      nowMs += ms
    },
    probeFn: async () => probes.shift(),
  })

  assert.equal(result.appReady, true)
  assert.deepEqual(sleeps, [200])
})

test('doctor wait 0 probes once without a fixed sleep', async () => {
  let probeCount = 0
  let sleepCount = 0

  const result = await waitForDoctorRuntimeProbe({}, {
    timeoutMs: 5000,
    waitMs: 0,
    probeFn: async () => {
      probeCount += 1
      return { connected: false, appReady: false }
    },
    sleepFn: async () => {
      sleepCount += 1
    },
  })

  assert.equal(result.connected, false)
  assert.equal(probeCount, 1)
  assert.equal(sleepCount, 0)
})

test('buildHelpText groups commands by priority and purpose', () => {
  const help = buildHelpText()

  assert.match(help, /核心命令（优先使用）/)
  assert.match(help, /诊断与结构（推荐）/)
  assert.match(help, /截图模式，默认 page/u)
  assert.match(help, /逃逸点（高级）/)
  assert.match(help, /会话与连接/)
  assert.match(help, /app inspect/)
  assert.match(help, /doctor/)
  assert.match(help, /protocol <method>/)
  assert.match(help, /devtools logs/)
  assert.match(help, /eval <js>/)
  assert.match(help, /session kill <name>/)
  assert.match(help, /back/)
  assert.match(help, /scroll/)
  assert.match(help, /swipe/)
  assert.match(help, /longpress/)
})

test('buildHelpText mentions summary and full detail options', () => {
  const help = buildHelpText()

  assert.match(help, /--all/)
  assert.match(help, /--sections <a,b,c>/)
  assert.match(help, /help <command>/)
  assert.match(help, /-v, --version/)
  assert.match(help, /--auto-port <port>.*隐藏|--auto-port <port>.*\/auto/i)
})

test('getVersionText returns package version', () => {
  assert.equal(getVersionText(), require('../package.json').version)
})

test('buildCommandHelpText returns open command details', () => {
  const help = buildCommandHelpText('open')

  assert.match(help, /^open\/connect/m)
  assert.match(help, /--session <name>/)
  assert.match(help, /--project <path>/)
  assert.match(help, /--devtools-project <path>/)
  assert.match(help, /--project-map <linux=windows>/)
  assert.match(help, /WECHAT_DEVTOOLS_CLI/)
  assert.match(help, /优先 attach|attach 到同项目唯一 live runtime/i)
  assert.match(help, /没有可复用 runtime 时才尝试启动新的|启动路径/i)
  assert.match(help, /--fresh .*失败时不会偷偷 attach|必须新起/i)
  assert.match(help, /显式 --auto-port.*fresh 启动|沿用 owner autoPort/i)
  assert.match(help, /ws connect <port>.*\/upgrade|不是 automation ws/i)
})

test('buildCommandHelpText returns screenshot mode details', () => {
  const help = buildCommandHelpText('screenshot')

  assert.match(help, /^screenshot/m)
  assert.match(help, /--mode <page\|visual\|annotate\|layout>/)
  assert.match(help, /--no-ref/)
  assert.match(help, /--focus <refs>/)
  assert.match(help, /--capsule/)
  assert.match(help, /-c\|--compact/)
  assert.match(help, /--raw/)
  assert.match(help, /layout/)
  assert.match(help, /默认模式是 page/u)
  assert.match(help, /相对或绝对文件路径/u)
  assert.match(help, /已有目录|目录分隔符/u)
})

test('buildCommandHelpText keeps snapshot default path parameter-free', () => {
  const help = buildCommandHelpText('snapshot')

  assert.match(help, /^snapshot/m)
  assert.match(help, /miniprogram-browser snapshot --session/u)
  assert.doesNotMatch(help, /snapshot -i/u)
  assert.doesNotMatch(help, /--visual/u)
  assert.match(help, /--layout/)
  assert.match(help, /ASCII/u)
  assert.match(help, /--no-map/u)
})

test('snapshot defaults to compact semantic output plus ASCII map', () => {
  assert.deepEqual(resolveSnapshotTreeOptions({}), {
    compact: true,
    depth: undefined,
  })
  assert.deepEqual(resolveSnapshotTreeOptions({ all: true, depth: '4' }), {
    compact: false,
    depth: 4,
  })
  assert.deepEqual(resolveSnapshotLayoutPolicy({}), {
    collectRects: true,
    renderMap: true,
    annotateLines: false,
  })
  assert.deepEqual(resolveSnapshotLayoutPolicy({ layout: true }), {
    collectRects: true,
    renderMap: true,
    annotateLines: true,
  })
  assert.deepEqual(resolveSnapshotLayoutPolicy({ layout: true, noMap: true }), {
    collectRects: true,
    renderMap: false,
    annotateLines: true,
  })
  assert.deepEqual(resolveSnapshotLayoutPolicy({ noMap: true }), {
    collectRects: false,
    renderMap: false,
    annotateLines: false,
  })
})

test('routine actions have no implicit fixed sleep', () => {
  for (const action of ['goto', 'click', 'fill', 'native']) {
    assert.equal(resolveActionWaitMs(action, undefined), 0, action)
  }
  assert.equal(resolveActionWaitMs('click', '350'), 350)
})

test('fill applies the value before honoring an explicit await condition', async () => {
  let inputValue = null
  const page = {
    path: 'pages/form/index',
    async $$(selector) {
      if (selector === '.saved' && inputValue === 'hello') {
        return [{ async size() { return { width: 10, height: 10 } } }]
      }
      return []
    },
  }
  const miniProgram = {
    async currentPage() {
      return page
    },
  }
  const element = {
    async input(value) {
      inputValue = value
    },
  }

  const result = await performInputAndWait(
    miniProgram,
    { route: page.path },
    element,
    'hello',
    { await: 'visible:.saved', timeout: 50 },
    page.path,
  )

  assert.equal(inputValue, 'hello')
  assert.equal(result.path, page.path)
  assert.equal(result.condition.kind, 'visible')
})

test('help distinguishes fixed waits from condition timeouts', () => {
  const generalHelp = buildHelpText()
  const waitHelp = buildCommandHelpText('wait')

  assert.match(generalHelp, /--wait <ms>.*固定等待/u)
  assert.match(generalHelp, /--timeout <ms>.*最大时长/u)
  assert.match(waitHelp, /完整等待指定毫秒/u)
})

test('buildCommandHelpText returns low-level diagnostic command details', () => {
  assert.match(buildCommandHelpText('doctor'), /App runtime|Tool\.getInfo/)
  assert.match(buildCommandHelpText('doctor'), /--project <path> --devtools-port <port>|bootstrap automation/u)
  assert.match(buildCommandHelpText('protocol'), /Tool\.getInfo|底层协议/)
  assert.match(buildCommandHelpText('devtools'), /WeappLog|底层日志/)
})

test('buildCommandHelpText returns await command details', () => {
  const help = buildCommandHelpText('await')

  assert.match(help, /^await/m)
  assert.match(help, /tool-ready|app-ready/)
  assert.match(help, /route:|selector:|visible:|hidden:|ref:/)
  assert.match(help, /change/)
  assert.match(help, /--timeout <ms>/)
})

test('interaction command help exposes concise real-user operations', () => {
  assert.match(buildCommandHelpText('back'), /返回上一页/u)
  assert.match(buildCommandHelpText('scroll'), /up\|down/u)
  assert.match(buildCommandHelpText('swipe'), /left\|right\|up\|down/u)
  assert.match(buildCommandHelpText('longpress'), /长按/u)
})

test('buildCommandHelpText returns project-scoped session management details', () => {
  const help = buildCommandHelpText('session')

  assert.match(help, /session list/)
  assert.match(help, /session kill <name>/)
  assert.match(help, /项目|project/)
  assert.match(help, /live|stale/)
  assert.match(help, /orphan launch/)
  assert.match(help, /session info/)
  assert.match(help, /活动 session/)
})

test('buildCommandHelpText returns read-only status details', () => {
  const help = buildCommandHelpText('status')

  assert.match(help, /只读/)
  assert.match(help, /owner\/attachedTo/)
  assert.match(help, /不启动 DevTools/)
})

test('attachFollowupPayload keeps fresh refs visible in text and JSON shapes', () => {
  const payload = attachFollowupPayload(
    { message: '已点击 @e1', path: '/pages/detail/index' },
    {
      route: '/pages/detail/index',
      count: 1,
      lines: ['@e2 button detail'],
      records: [{ ref: '@e2' }],
    },
  )

  assert.match(payload.message, /已刷新 snapshot/)
  assert.deepEqual(payload.lines, [payload.message, '@e2 button detail'])
  assert.deepEqual(payload.followup.records, [{ ref: '@e2' }])
})

test('parseFocusRefs normalizes comma separated focus refs', () => {
  assert.deepEqual(parseFocusRefs('@e1,@e2  @e3,@e1'), ['@e1', '@e2', '@e3'])
  assert.deepEqual(parseFocusRefs(undefined), [])
})

test('parseArgs keeps layout as boolean flag after session option', () => {
  const parsed = parseArgs(['snapshot', '-i', '--session', 'demo', '--layout'])
  assert.deepEqual(parsed.positional, ['snapshot'])
  assert.equal(parsed.options.session, 'demo')
  assert.equal(parsed.options.sessionProvided, true)
  assert.equal(parsed.options.layout, true)
})

test('parseArgs keeps layout as boolean flag before session option', () => {
  const parsed = parseArgs(['snapshot', '-i', '--layout', '--session', 'demo'])
  assert.deepEqual(parsed.positional, ['snapshot'])
  assert.equal(parsed.options.session, 'demo')
  assert.equal(parsed.options.sessionProvided, true)
  assert.equal(parsed.options.layout, true)
})

test('parseArgs keeps no-ref as boolean flag for screenshot', () => {
  const parsed = parseArgs(['screenshot', '--session', 'demo', '--mode', 'layout', '--no-ref'])
  assert.deepEqual(parsed.positional, ['screenshot'])
  assert.equal(parsed.options.session, 'demo')
  assert.equal(parsed.options.mode, 'layout')
  assert.equal(parsed.options.noRef, true)
})

test('parseArgs keeps screenshot output path positional and rejects misleading --path', () => {
  const parsed = parseArgs(['screenshot', '../captures/', '--session', 'demo'])
  assert.deepEqual(parsed.positional, ['screenshot', '../captures/'])

  assert.throws(
    () => parseArgs(['screenshot', '--path', '../captures/']),
    /Unknown option --path.*screenshot \[path\]/u,
  )
})

test('parseArgs keeps capture-screenshot as boolean flag for doctor', () => {
  const parsed = parseArgs(['doctor', '--session', 'demo', '--capture-screenshot'])
  assert.deepEqual(parsed.positional, ['doctor'])
  assert.equal(parsed.options.session, 'demo')
  assert.equal(parsed.options.captureScreenshot, true)
})

test('parseArgs rejects value options when the value is missing', () => {
  assert.throws(
    () => parseArgs(['open', '--session', '--json']),
    /--session.*value|--session.*值/i,
  )
})

test('parseArgs supports disabling DevTools trust-project flag', () => {
  const parsed = parseArgs(['open', '--session', 'demo', '--no-trust-project'])
  assert.equal(parsed.options.session, 'demo')
  assert.equal(parsed.options.trustProject, false)
})

test('parseArgs supports enabling DevTools trust-project flag', () => {
  const parsed = parseArgs(['open', '--session', 'demo', '--trust-project'])
  assert.equal(parsed.options.session, 'demo')
  assert.equal(parsed.options.trustProject, true)
})

test('parseArgs supports explicit fresh runtime escape hatch', () => {
  const parsed = parseArgs(['open', '--session', 'demo', '--fresh'])
  assert.equal(parsed.options.session, 'demo')
  assert.equal(parsed.options.fresh, true)
})

test('parseArgs supports explicit await, follow-up snapshot, and disabling implicit await', () => {
  const parsed = parseArgs(['click', '@e1', '--session', 'demo', '--await', 'route-settled', '--no-await', '--follow'])

  assert.deepEqual(parsed.positional, ['click', '@e1'])
  assert.equal(parsed.options.session, 'demo')
  assert.equal(parsed.options.await, 'route-settled')
  assert.equal(parsed.options.noAwait, true)
  assert.equal(parsed.options.follow, true)
})

test('buildCliErrorPayload keeps the error envelope short and stable', () => {
  const payload = buildCliErrorPayload({
    code: 'AWAIT_TIMEOUT',
    message: 'await app-ready timed out after 90000ms',
    hint: 'phase=app-ready; last=App.getCurrentPage timeout',
    log: 'routeTo appLaunch timeout',
    next: 'devtools logs',
    raw: 'raw details',
  })

  assert.deepEqual(payload, {
    ok: false,
    error: {
      code: 'AWAIT_TIMEOUT',
      message: 'await app-ready timed out after 90000ms',
      hint: 'phase=app-ready; last=App.getCurrentPage timeout',
      log: 'routeTo appLaunch timeout',
      next: 'devtools logs',
      raw: 'raw details',
    },
  })
})

test('normalizeOpenStableWaitError degrades runtime stable timeout into an open result fact', () => {
  const normalized = normalizeOpenStableWaitError({
    code: 'RUNTIME_UNSTABLE',
    message: 'runtime stable timed out after 15000ms',
    hint: 'phase=stable; current=pages/home/index; stableMs=300',
    next: 'await stable',
    diagnostics: {
      path: 'pages/home/index',
    },
  })

  assert.equal(normalized.stable, null)
  assert.deepEqual(normalized.stableTimeout, {
    message: 'runtime stable timed out after 15000ms',
    hint: 'phase=stable; current=pages/home/index; stableMs=300',
    next: 'await stable',
    diagnostics: {
      path: 'pages/home/index',
    },
  })

  assert.throws(
    () => normalizeOpenStableWaitError({ code: 'APPID_MISSING', message: 'appid missing' }),
    (error) => error && error.code === 'APPID_MISSING' && error.message === 'appid missing',
  )
})

test('summarizeOpenResolution distinguishes attachable and start-required startup paths', () => {
  assert.equal(summarizeOpenResolution({}, []), 'start-required')
  assert.equal(summarizeOpenResolution({ devtoolsPort: '23986' }, []), 'adopt-via-devtools-port')
  assert.equal(summarizeOpenResolution({}, [{ name: 'owner', autoPort: '9431' }]), 'attachable')
  assert.equal(summarizeOpenResolution({ autoPort: '9555' }, [{ name: 'owner', autoPort: '9431' }]), 'attach-blocked-by-auto-port')
  // 多个不同 live 端口需要 session 选择；同端口多行仍只算一个 runtime
  assert.equal(summarizeOpenResolution({}, [{ name: 'a', autoPort: '9431' }, { name: 'b', autoPort: '9432' }]), 'ambiguous')
  assert.equal(summarizeOpenResolution({}, [{ name: 'a', autoPort: '9431' }, { name: 'b', autoPort: '9431' }]), 'attachable')
})

test('resolveOpenFailureNextAction only suggests attach fallback when the request was fresh or auto-port pinned', () => {
  assert.equal(resolveOpenFailureNextAction({}, []), '')
  assert.equal(resolveOpenFailureNextAction({ fresh: true }, [{ name: 'owner', autoPort: '9431' }]), 'open without --fresh')
  assert.equal(resolveOpenFailureNextAction({ autoPort: '9555' }, [{ name: 'owner', autoPort: '9431' }]), 'open without --auto-port')
  assert.equal(
    resolveOpenFailureNextAction({}, [{ name: 'a', autoPort: '9431' }, { name: 'b', autoPort: '9432' }]),
    'session list; then use --session <name>',
  )
})

test('createMultipleLiveRuntimeError lists session candidates without exposing port selection as the action', () => {
  const error = createMultipleLiveRuntimeError({ config: { projectPath: '/tmp/shop' } }, [
    { name: 'work', autoPort: '9431', route: '/pages/home/index' },
    { name: 'debug', autoPort: '9432', route: '/pages/settings/index' },
  ])

  assert.equal(error.code, 'MULTIPLE_LIVE_RUNTIMES')
  assert.match(error.message, /多个 live runtime/)
  assert.match(error.message, /--session <name>/)
  assert.match(error.message, /work.*autoPort=9431/)
  assert.match(error.message, /debug.*autoPort=9432/)
  assert.match(error.message, /miniprogram-browser snapshot --session work/)
  assert.match(error.message, /miniprogram-browser open --session new --fresh/)
  assert.match(error.hint, /不需要手动指定 autoPort/)
  assert.equal(error.next, 'session list')
  assert.deepEqual(error.diagnostics.nextCommands, [
    'miniprogram-browser snapshot --session work',
    'miniprogram-browser snapshot --session debug',
    'miniprogram-browser open --session new --fresh',
  ])
  assert.deepEqual(error.diagnostics.liveSameProjectRuntimes.map((item) => item.name), ['work', 'debug'])
})

test('shouldRetryOpenWithAnotherAutoPort only retries auto-assigned fresh startup failures', () => {
  const state = {
    portResolution: {
      autoPortAssigned: true,
    },
  }

  assert.equal(
    shouldRetryOpenWithAnotherAutoPort(state, {}, 'started', {
      message: 'Failed connecting to ws://127.0.0.1:9515, check if target project window is opened with automation enabled',
    }, 1),
    true,
  )
  assert.equal(
    shouldRetryOpenWithAnotherAutoPort(state, {}, 'started', {
      code: 'OPEN_TIMEOUT',
      cause: {
        message: 'Failed connecting to ws://127.0.0.1:9515, check if target project window is opened with automation enabled',
      },
    }, 1),
    true,
  )
  // 冷启动：OPEN_TIMEOUT / 扫端口全空 允许同一次 open 内换 port 再 auto
  assert.equal(
    shouldRetryOpenWithAnotherAutoPort(state, {}, 'started', { code: 'OPEN_TIMEOUT' }, 1),
    true,
  )
  assert.equal(
    shouldRetryOpenWithAnotherAutoPort(state, {}, 'started', {
      code: 'OPEN_TIMEOUT',
      message: '冷启动未完成：devtools auto 已返回，但本机未发现可用 automation WebSocket',
    }, 1),
    true,
  )
  assert.equal(
    shouldRetryOpenWithAnotherAutoPort(state, {}, 'started', {
      code: 'OPEN_TIMEOUT',
      message: 'runtime stable timed out after 15000ms',
    }, 1),
    true,
  )
  assert.equal(
    shouldRetryOpenWithAnotherAutoPort(state, { autoPort: '9515' }, 'started', { code: 'OPEN_TIMEOUT' }, 1),
    false,
  )
  assert.equal(
    shouldRetryOpenWithAnotherAutoPort(state, {}, 'started', { code: 'APPID_MISSING' }, 1),
    false,
  )
  // 假成功 auto + cli server 类：仍允许换 port 重试（同一次 open）
  assert.equal(
    shouldRetryOpenWithAnotherAutoPort(state, {}, 'started', { code: 'DEVTOOLS_AUTOMATION_SERVER_FAILED' }, 1),
    true,
  )
  assert.equal(
    shouldRetryOpenWithAnotherAutoPort(state, {}, 'started', {
      code: 'OPEN_TIMEOUT',
      diagnostics: {
        startupHints: [{ code: 'cli-server-start-error' }],
      },
    }, 1),
    true,
  )
  assert.equal(
    shouldRetryOpenWithAnotherAutoPort(state, {}, 'started', {
      code: 'OPEN_TIMEOUT',
      startupIssueCode: 'DEVTOOLS_LOGIN_REQUIRED',
    }, 1),
    false,
  )
  assert.equal(
    shouldRetryOpenWithAnotherAutoPort(state, {}, 'started', {
      code: 'OPEN_TIMEOUT',
      startupIssueCode: 'DEVTOOLS_PLUGIN_MISSING',
    }, 1),
    true,
  )
  assert.equal(
    shouldRetryOpenWithAnotherAutoPort(state, {}, 'connected', { code: 'OPEN_TIMEOUT' }, 1),
    false,
  )
  assert.equal(
    shouldRetryOpenWithAnotherAutoPort(state, {}, 'started', { code: 'WINDOWS_SOCKET_EXHAUSTED' }, 1),
    false,
  )
})

test('shouldClearFailedOpenSession clears when close is ok or not attempted', () => {
  assert.equal(
    shouldClearFailedOpenSession({ attempted: true, ok: false }),
    false,
  )
  assert.equal(
    shouldClearFailedOpenSession({ attempted: true, ok: true }),
    true,
  )
  assert.equal(
    shouldClearFailedOpenSession({ attempted: false }),
    true,
  )
  assert.equal(
    shouldClearFailedOpenSession(null),
    true,
  )
})

test('summarizeTimelinePayload keeps only high-value route fields by default', () => {
  const result = summarizeTimelinePayload({
    events: [
      { ts: 1, kind: 'route', from: 'pages/a/index', to: 'pages/b/index', openType: 'navigateTo', message: 'navigateTo pages/a/index -> pages/b/index' },
      { ts: 2, kind: 'route', from: 'pages/b/index', to: 'pages/c/index', openType: 'navigateTo', message: 'navigateTo pages/b/index -> pages/c/index' },
      { ts: 3, kind: 'route', from: 'pages/c/index', to: 'pages/d/index', openType: 'navigateTo', message: 'navigateTo pages/c/index -> pages/d/index' },
      { ts: 4, kind: 'route', from: 'pages/d/index', to: 'pages/e/index', openType: 'navigateTo', message: 'navigateTo pages/d/index -> pages/e/index' },
      { ts: 5, kind: 'route', from: 'pages/e/index', to: 'pages/f/index', openType: 'navigateTo', message: 'navigateTo pages/e/index -> pages/f/index' },
      { ts: 6, kind: 'route', from: 'pages/f/index', to: 'pages/g/index', openType: 'navigateTo', message: 'navigateTo pages/f/index -> pages/g/index' },
      { ts: 7, kind: 'route', from: 'pages/g/index', to: 'pages/h/index', openType: 'navigateTo', message: 'navigateTo pages/g/index -> pages/h/index' },
    ],
  }, {})

  assert.deepEqual(result, {
    count: 7,
    events: [
      { kind: 'route', from: 'pages/c/index', to: 'pages/d/index', openType: 'navigateTo', message: 'navigateTo pages/c/index -> pages/d/index' },
      { kind: 'route', from: 'pages/d/index', to: 'pages/e/index', openType: 'navigateTo', message: 'navigateTo pages/d/index -> pages/e/index' },
      { kind: 'route', from: 'pages/e/index', to: 'pages/f/index', openType: 'navigateTo', message: 'navigateTo pages/e/index -> pages/f/index' },
      { kind: 'route', from: 'pages/f/index', to: 'pages/g/index', openType: 'navigateTo', message: 'navigateTo pages/f/index -> pages/g/index' },
      { kind: 'route', from: 'pages/g/index', to: 'pages/h/index', openType: 'navigateTo', message: 'navigateTo pages/g/index -> pages/h/index' },
    ],
    truncated: true,
  })
})

test('summarizeSnapshotPayload keeps text lines but removes JSON duplication unless --all', () => {
  const payload = {
    state: { route: 'pages/dashboard/index' },
    records: [{ ref: '@e1', kind: 'button', text: '保存', route: 'pages/dashboard/index', rectPct: { x: 10, y: 20, w: 30, h: 40 } }],
    lines: ['@e1 [button] 保存'],
  }

  assert.deepEqual(summarizeSnapshotPayload(payload, { json: true }), {
    route: 'pages/dashboard/index',
    count: 1,
    records: [{ ref: '@e1', kind: 'button', text: '保存', rectPct: { x: 10, y: 20, w: 30, h: 40 } }],
  })
  assert.deepEqual(summarizeSnapshotPayload(payload, {}).lines, ['@e1 [button] 保存'])
  assert.equal(summarizeSnapshotPayload(payload, { all: true }).state.route, 'pages/dashboard/index')
})

test('summarizeDevtoolsStartupHints extracts high-value startup diagnostics from DevTools logs', () => {
  const hints = summarizeDevtoolsStartupHints({
    files: [
      {
        lines: [
          '[ERROR] Error: 系统错误，错误码：41002,appid missing',
          '[ERROR] routeTo appLaunch timeout',
          '[ERROR] start cli server error: [object Object]',
          '[ERROR:tcp_socket_win.cc(879)] connect failed: 10055',
        ],
      },
      {
        lines: [
          '[ERROR] older unrelated file',
        ],
      },
    ],
  })

  assert.deepEqual(hints.map((item) => item.code), [
    'appid-missing',
    'app-launch-timeout',
    'cli-server-start-error',
    'windows-socket-10055',
  ])
  assert.match(hints[0].message, /appid|AppID/i)
  assert.match(hints[1].sample, /appLaunch timeout/i)
})

test('summarizeDevtoolsStartupHints ignores older log files after the latest matching file', () => {
  const hints = summarizeDevtoolsStartupHints({
    files: [
      {
        path: '/tmp/logs/2026-05-03-latest.log',
        lines: [
          '[ERROR] start cli server error: [object Object]',
        ],
      },
      {
        path: '/tmp/logs/2026-05-03-older.log',
        lines: [
          '[ERROR] Error: 系统错误，错误码：41002,appid missing',
        ],
      },
    ],
  })

  assert.deepEqual(hints.map((item) => item.code), ['cli-server-start-error'])
})

test('summarizeDevtoolsStartupHints prefers timestamped log files over stale stderr noise', () => {
  const hints = summarizeDevtoolsStartupHints({
    files: [
      {
        path: '/tmp/stderr.log',
        lines: [
          '[ERROR:tcp_socket_win.cc(879)] connect failed: 10055',
        ],
      },
      {
        path: '/tmp/logs/2026-05-03-11-26-41.log',
        lines: [
          '[ERROR] Error: 系统错误，错误码：41002,appid missing',
          '[ERROR] start cli server error: [object Object]',
        ],
      },
    ],
  })

  assert.deepEqual(hints.map((item) => item.code), [
    'appid-missing',
    'cli-server-start-error',
  ])
})

test('summarizeDevtoolsStartupHints does not fall back to stderr when current timestamped logs have no startup hints', () => {
  const hints = summarizeDevtoolsStartupHints({
    files: [
      {
        path: '/tmp/stderr.log',
        lines: [
          '[ERROR:tcp_socket_win.cc(879)] connect failed: 10055',
        ],
      },
      {
        path: '/tmp/logs/2026-05-03-11-41-03.log',
        lines: [
          '[INFO] [ideplugin] extension heartbeat ok',
        ],
      },
    ],
  })

  assert.deepEqual(hints, [])
})

test('classifyOpenFailureFromStartupHints treats cli-server-start-error as automation startup failure', () => {
  const classification = classifyOpenFailureFromStartupHints([
    { code: 'cli-server-start-error', sample: '[ERROR] start cli server error: [object Object]' },
  ])

  assert.deepEqual(classification, {
    code: 'DEVTOOLS_AUTOMATION_SERVER_FAILED',
    hint: 'devtoolsLog=cli-server-start-error',
  })
})

test('summarizeDevtoolsStartupHints recognizes current DevTools login failure signals', () => {
  const hints = summarizeDevtoolsStartupHints({
    files: [
      {
        path: '/tmp/logs/2026-08-01-latest.log',
        lines: [
          '[ERROR] getNewTicket empty ticket',
          '[ERROR] errcode= 41001 Error: 需要重新登录,access_token missing',
          '[ERROR] start cli server error: [object Object]',
        ],
      },
    ],
  })

  assert.deepEqual(hints.map((item) => item.code), ['login-expired', 'cli-server-start-error'])
  assert.match(hints[0].message, /重新登录/)
})

test('classifyOpenFailureFromStartupHints prioritizes login failure over automation server noise', () => {
  const classification = classifyOpenFailureFromStartupHints([
    { code: 'login-expired', sample: '[ERROR] errcode= 41001 需要重新登录,access_token missing' },
    { code: 'cli-server-start-error', sample: '[ERROR] start cli server error: [object Object]' },
  ])

  assert.deepEqual(classification, {
    code: 'DEVTOOLS_LOGIN_REQUIRED',
    hint: 'devtoolsLog=login-expired',
  })
})

test('summarizeDevtoolsStartupHints recognizes missing automation plugin signals', () => {
  const hints = summarizeDevtoolsStartupHints({
    files: [
      {
        path: '/tmp/logs/2026-08-01-plugin.log',
        lines: [
          '[ERROR] [ideplugin] get devtools manifest.json catch error Error: not installed',
          '[ERROR] start cli server error: [object Object]',
        ],
      },
    ],
  })

  assert.deepEqual(hints.map((item) => item.code), ['devtools-plugin-missing', 'cli-server-start-error'])
  assert.match(hints[0].message, /插件|plugin/i)
})

test('classifyOpenFailureFromStartupHints prioritizes missing plugin over generic server noise', () => {
  const classification = classifyOpenFailureFromStartupHints([
    { code: 'devtools-plugin-missing', sample: '[ERROR] [ideplugin] manifest.json not installed' },
    { code: 'cli-server-start-error', sample: '[ERROR] start cli server error: [object Object]' },
  ])

  assert.deepEqual(classification, {
    code: 'DEVTOOLS_PLUGIN_MISSING',
    hint: 'devtoolsLog=devtools-plugin-missing',
  })
})

test('classifyOpenFailureFromStartupHints prefers app launch timeout over cli server noise', () => {
  const classification = classifyOpenFailureFromStartupHints([
    { code: 'cli-server-start-error', sample: '[ERROR] start cli server error: [object Object]' },
    { code: 'app-launch-timeout', sample: '[ERROR] routeTo appLaunch timeout' },
  ])

  assert.deepEqual(classification, {
    code: 'APP_LAUNCH_TIMEOUT',
    hint: 'devtoolsLog=app-launch-timeout',
  })
})

test('classifyOpenFailureFromStartupHints prefers the summarized latest log line over weaker hint codes', () => {
  const classification = classifyOpenFailureFromStartupHints([
    { code: 'appid-missing', sample: '[WARN] appid missing' },
    { code: 'cli-server-start-error', sample: '[ERROR] start cli server error: [object Object]' },
  ], {
    summaryLine: '[2026-05-03 11:28:04.874][ERROR] start cli server error: [object Object]',
  })

  assert.deepEqual(classification, {
    code: 'DEVTOOLS_AUTOMATION_SERVER_FAILED',
    hint: 'devtoolsLog=cli-server-start-error',
  })
})

test('shouldEmitPreludeNotices skips logs and exceptions', () => {
  assert.equal(shouldEmitPreludeNotices('path'), true)
  assert.equal(shouldEmitPreludeNotices('timeline'), true)
  assert.equal(shouldEmitPreludeNotices('logs'), false)
  assert.equal(shouldEmitPreludeNotices('exceptions'), false)
  assert.equal(shouldEmitPreludeNotices('await'), false)
  assert.equal(shouldEmitPreludeNotices('wait'), false)
})

test('shouldAttemptVisualProbe only triggers when needed', () => {
  assert.equal(shouldAttemptVisualProbe({ pendingVisualAction: null, lastVisualProbe: null }, 'pages/a/index', null, { visual: true }), true)
  assert.equal(shouldAttemptVisualProbe({ pendingVisualAction: null, lastVisualProbe: { route: 'pages/a/index' } }, 'pages/a/index', null, { visual: true }), false)
  assert.equal(shouldAttemptVisualProbe({ pendingVisualAction: { route: 'pages/a/index' }, lastVisualProbe: { route: 'pages/a/index' } }, 'pages/a/index', null, { visual: true }), true)
  assert.equal(shouldAttemptVisualProbe({ pendingVisualAction: { route: 'pages/a/index' }, lastVisualProbe: { route: 'pages/a/index' } }, 'pages/a/index', '@e1', { visual: true }), false)
  assert.equal(shouldAttemptVisualProbe({ pendingVisualAction: null, lastVisualProbe: null }, 'pages/a/index', null, {}), false)
})
