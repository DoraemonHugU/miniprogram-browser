const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { isSuccessfulResult } = require('../scripts/lib/e2e-harness.cjs')

// 执行门禁本身的分支；所有 CLI 响应都是合成数据，不启动 DevTools。
function runGate(file, options = {}) {
  const sessions = []
  const calls = []
  let currentPath = 'pages/index/index'
  const h = {
    project: '/synthetic/public-demo',
    ensureEnv() {},
    log() {},
    fail(reason) { throw new Error(reason) },
    assertOk(ok, reason) { if (!ok) this.fail(reason) },
    openSession(name) {
      sessions.push(name)
      return { session: name, autoPort: options.differentPort && sessions.length > 1 ? '9516' : '9515', mode: sessions.length > 1 ? 'attached' : 'started', path: 'pages/index/index' }
    },
    installSessionCleanup() { return { run: () => [{ status: 0, ok: true }], add() {} } },
    runCli(args) {
      calls.push(args)
      let payload = { path: currentPath }
      if (args[0] === 'snapshot') payload = { count: options.emptySnapshot ? 0 : 1, records: [{ ref: '@e1', kind: 'navigator' }] }
      if (args[0] === 'session') payload = { sessions: sessions.map((name) => ({ name })) }
      if (args[0] === 'goto') {
        if (!options.allowNavigation || args[1].includes('interaction')) {
          return { status: 1, stdout: JSON.stringify({ ok: false, error: 'synthetic await failure' }) }
        }
        currentPath = args[1].replace(/^\//u, '')
        payload = { path: currentPath }
      }
      if (args[0] === 'logs') payload = { events: [] }
      if (args[0] === 'page-stack') payload = { pages: options.emptyPageStack ? [] : [{ path: currentPath }] }
      if (args[0] === options.failureCommand) payload = { ok: false, error: 'synthetic protocol failure' }
      if (args[0] === options.malformedCommand) payload = {}
      return { status: 0, stdout: JSON.stringify(payload) }
    },
    parseJsonStdout(result) { return JSON.parse(result.stdout) },
  }
  let error
  try {
    vm.runInNewContext(fs.readFileSync(require.resolve(`../scripts/${file}`), 'utf8'), {
      require: (id) => id === './lib/e2e-harness.cjs' ? { createHarness: () => h, isSuccessfulResult } : require(id),
      process: { env: {}, exit(code) { throw new Error(`exit ${code}`) } },
    })
  } catch (caught) { error = caught }
  return { error, calls }
}

function runModalGate(options = {}) {
  const calls = []
  const statuses = [...(options.statuses || [
    'Status: Ready',
    'Status: Modal accepted',
    'Status: Ready',
    'Status: Modal dismissed',
  ])]
  const exitHandlers = []
  let cleanupRuns = 0
  let cleanupActive = true
  const fakeProcess = {
    env: {},
    once(event, handler) {
      if (event === 'exit') exitHandlers.push(handler)
    },
    exit(code, reason) {
      for (const handler of exitHandlers) handler()
      const error = new Error(reason || `exit ${code}`)
      error.code = code
      throw error
    },
  }
  const h = {
    project: '/synthetic/public-demo',
    ensureEnv() {},
    log() {},
    fail(reason) { fakeProcess.exit(1, reason) },
    assertOk(ok, reason, detail) { if (!ok) this.fail(reason, detail) },
    openSession(name) {
      calls.push(['open', name])
      return { session: name, autoPort: '9515', mode: 'started', path: 'pages/index/index' }
    },
    installSessionCleanup(names) {
      calls.push(['cleanup-register', ...names])
      const cleanup = {
        add() {},
        run() {
          if (!cleanupActive) return []
          cleanupActive = false
          cleanupRuns += 1
          return options.cleanupResults || [{ status: 0, ok: true }]
        },
      }
      fakeProcess.once('exit', cleanup.run)
      return cleanup
    },
    runCli(args) {
      calls.push(args)
      if (args[0] === 'goto') {
        return { status: 0, stdout: JSON.stringify({ path: args[1].replace(/^\//u, '') }) }
      }
      if (args[0] === 'get') {
        return { status: 0, stdout: JSON.stringify({ text: statuses.shift() || 'Status: Ready' }) }
      }
      if (args[0] === 'native') {
        if (options.nativeFailure) {
          return { status: 1, stdout: JSON.stringify({ error: 'synthetic native failure' }) }
        }
        return { status: 0, stdout: JSON.stringify({ result: {} }) }
      }
      if (args[0] === 'screenshot') {
        return { status: 0, stdout: JSON.stringify({ path: '/tmp/modal-failure.png' }) }
      }
      return { status: 0, stdout: JSON.stringify({ message: 'synthetic success' }) }
    },
    parseJsonStdout(result) { return JSON.parse(result.stdout) },
  }
  const fakeRequire = (id) => id === './lib/e2e-harness.cjs'
    ? { createHarness: () => h, isSuccessfulResult }
    : require(id)
  const fakeModule = { exports: {} }
  fakeRequire.main = fakeModule
  let error
  try {
    vm.runInNewContext(fs.readFileSync(require.resolve('../scripts/modal-e2e.cjs'), 'utf8'), {
      require: fakeRequire,
      module: fakeModule,
      process: fakeProcess,
    })
  } catch (caught) {
    error = caught
  }
  return { error, calls, cleanupRuns }
}

test('real open gate rejects an empty snapshot even when the CLI exits successfully', () => {
  assert.match(runGate('real-open-gate.cjs', { emptySnapshot: true }).error.message, /snapshot failed or empty/u)
})

test('L0 gate fails when its second session gets a different runtime', () => {
  assert.match(runGate('l0-e2e.cjs', { differentPort: true }).error.message, /did not reuse the same runtime/u)
})

test('L0 gate never retries a failed route wait without the condition', () => {
  const result = runGate('l0-e2e.cjs')
  assert.match(result.error.message, /goto.tools/u)
  const navigation = result.calls.filter((args) => args[0] === 'goto')
  assert.equal(navigation.length, 1)
  assert.ok(navigation[0].includes('--await'))
})

for (const [command, label] of [['logs', 'logs.list'], ['page-stack', 'page-stack']]) {
  test(`L0 gate rejects ${command} JSON failure despite successful process exit`, () => {
    const result = runGate('l0-e2e.cjs', { allowNavigation: true, failureCommand: command })
    assert.ok(result.calls.some((args) => args[0] === command))
    assert.equal(result.error.message, label)
  })

  test(`L0 gate rejects missing ${command} result data`, () => {
    const result = runGate('l0-e2e.cjs', { allowNavigation: true, malformedCommand: command })
    assert.equal(result.error.message, label)
  })
}

test('L0 gate rejects an empty page stack after successful navigation', () => {
  const result = runGate('l0-e2e.cjs', { allowNavigation: true, emptyPageStack: true })
  assert.equal(result.error.message, 'page-stack')
})

test('L0 gate accepts empty logs and a nonempty page stack', () => {
  const result = runGate('l0-e2e.cjs', { allowNavigation: true })
  assert.ok(result.calls.some((args) => args[0] === 'page-stack'))
  assert.equal(result.error.message, 'interaction.goto')
})

test('modal gate rejects empty native output when the business status stays Ready and cleans up', () => {
  const result = runModalGate({ statuses: ['Status: Ready', 'Status: Ready'] })
  assert.match(result.error.message, /modal\.confirmModal callback was not verified/u)
  assert.equal(result.cleanupRuns, 1)
  assert.ok(result.calls.some((args) => args[0] === 'screenshot'))
})

test('modal gate rejects the wrong confirm/cancel direction', () => {
  const confirmResult = runModalGate({ statuses: ['Status: Ready', 'Status: Modal dismissed'] })
  assert.match(confirmResult.error.message, /modal\.confirmModal callback was not verified/u)

  const cancelResult = runModalGate({ statuses: [
    'Status: Ready',
    'Status: Modal accepted',
    'Status: Ready',
    'Status: Modal accepted',
  ] })
  assert.match(cancelResult.error.message, /modal\.cancelModal callback was not verified/u)
})

test('modal gate runs both branches and accepts only their exact callback status', () => {
  const result = runModalGate()
  assert.equal(result.error.message, 'exit 0')
  assert.equal(result.cleanupRuns, 1)
  const commands = result.calls.filter((args) => args[0] !== 'cleanup-register')
  assert.deepEqual(commands.map((args) => args[0]), [
    'open', 'goto', 'get', 'click', 'native', 'get',
    'goto', 'get', 'click', 'native', 'get',
  ])
  for (const args of commands.slice(1)) {
    assert.equal(args[args.indexOf('--session') + 1], commands[0][1])
    assert.equal(args[args.indexOf('--project') + 1], '/synthetic/public-demo')
  }
  const nativeCalls = result.calls.filter((args) => args[0] === 'native')
  assert.deepEqual(nativeCalls.map((args) => args[1]), ['confirmModal', 'cancelModal'])
  for (const args of nativeCalls) {
    const awaitIndex = args.indexOf('--await')
    assert.equal(args[awaitIndex + 1], 'change')
    assert.equal(args[args.indexOf('--timeout') + 1], '3000')
    assert.equal(args.includes('--wait'), false)
  }
})

test('modal gate rejects a native command failure even when the status matches', () => {
  const result = runModalGate({ nativeFailure: true })
  assert.match(result.error.message, /modal\.confirmModal callback was not verified/u)
  assert.equal(result.cleanupRuns, 1)
})

test('modal gate rejects unverified cleanup after both callback branches pass', () => {
  const result = runModalGate({ cleanupResults: [{ status: 0, ok: false }] })
  assert.match(result.error.message, /session cleanup failed/u)
  assert.equal(result.cleanupRuns, 1)
})
