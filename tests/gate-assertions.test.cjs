const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { isSuccessfulResult } = require('../scripts/lib/e2e-harness.cjs')

// 执行门禁本身的分支；所有 CLI 响应都是合成数据，不启动 DevTools。
function runGate(file, options = {}) {
  const sessions = []
  const calls = []
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
      let payload = { path: 'pages/index/index' }
      if (args[0] === 'snapshot') payload = { count: options.emptySnapshot ? 0 : 1, records: [{ ref: '@e1', kind: 'navigator' }] }
      if (args[0] === 'session') payload = { sessions: sessions.map((name) => ({ name })) }
      if (args[0] === 'goto') return { status: 1, stdout: JSON.stringify({ ok: false, error: 'synthetic await failure' }) }
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
