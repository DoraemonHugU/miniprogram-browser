const test = require('node:test')
const assert = require('node:assert/strict')
const runtime = require('../dist/lib/runtime.js')
const sessions = require('../dist/lib/session-store.js')

// 只使用内存中的合成诊断，禁止测试接触本机 DevTools 日志或启动真实工具。
function loadCli(t) {
  let logReads = 0
  let sessionConfig
  t.mock.method(runtime, 'collectDevtoolsLogs', async () => {
    logReads += 1
    return { files: [{ lines: ['[ERROR] INVALID_LOGIN synthetic-other-project'] }] }
  })
  t.mock.method(runtime, 'buildAutomationArgs', () => ({ args: [], projectStrategy: 'direct' }))
  t.mock.method(runtime, 'isAutomationEndpointLive', async () => false)
  t.mock.method(runtime, 'enableAutomation', async () => ({
    startupIssue: { code: 'CURRENT_CALL_FAILED', raw: 'synthetic current invocation error' },
  }))
  t.mock.method(runtime, 'probeAutomationRuntime', async () => ({ connected: false, appReady: false }))
  t.mock.method(sessions, 'assertProjectPath', () => {})
  t.mock.method(sessions, 'listSessionStates', async (config) => {
    sessionConfig = config
    return []
  })
  const modulePath = require.resolve('../dist/miniprogram-browser.js')
  delete require.cache[modulePath]
  t.after(() => { delete require.cache[modulePath] })
  return {
    cli: require(modulePath),
    logReads: () => logReads,
    sessionConfig: () => sessionConfig,
  }
}

const state = { name: 'privacy-test', config: { projectPath: '/synthetic/public-demo' } }

test('open failure preserves this invocation error without reading shared DevTools logs', async (t) => {
  const loaded = loadCli(t)
  const error = await loaded.cli.enrichOpenFailure({
    code: 'OPEN_TIMEOUT', message: 'open timed out', raw: 'synthetic current invocation error',
  }, state, { timeout: 1 })
  assert.equal(loaded.logReads(), 0)
  assert.equal(loaded.sessionConfig(), state.config)
  assert.equal(error.code, 'OPEN_TIMEOUT')
  assert.equal(error.raw, 'synthetic current invocation error')
  assert.equal(error.log, undefined)
})

test('automation wait timeout does not read shared DevTools logs', async (t) => {
  const loaded = loadCli(t)
  await assert.rejects(
    loaded.cli.waitForAutomationCondition(state, { kind: 'app-ready', raw: 'app-ready' }, { timeout: 1 }),
    (error) => error.code === 'AWAIT_TIMEOUT' && error.log === undefined,
  )
  assert.equal(loaded.logReads(), 0)
})

test('doctor uses only this invocation diagnostic when its endpoint is unavailable', async (t) => {
  const loaded = loadCli(t)
  let output = ''
  t.mock.method(console, 'log', (chunk) => { output += chunk })
  await loaded.cli.handleDoctor(state, { timeout: 1, wait: 0, json: true })
  assert.equal(loaded.logReads(), 0)
  const payload = JSON.parse(output)
  assert.equal(payload.ok, false)
  assert.equal(payload.automation.startupIssue.raw, 'synthetic current invocation error')
  assert.equal(payload.automation.log, undefined)
})
