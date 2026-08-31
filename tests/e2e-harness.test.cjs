const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const childProcess = require('node:child_process')

function withHarnessEnv(env, run) {
  const modulePath = require.resolve('../scripts/lib/e2e-harness.cjs')
  const previous = {
    project: process.env.MINIPROGRAM_BROWSER_GATE_PROJECT,
    cli: process.env.WECHAT_DEVTOOLS_CLI,
  }
  if (env.project === undefined) delete process.env.MINIPROGRAM_BROWSER_GATE_PROJECT
  else process.env.MINIPROGRAM_BROWSER_GATE_PROJECT = env.project
  if (env.cli === undefined) delete process.env.WECHAT_DEVTOOLS_CLI
  else process.env.WECHAT_DEVTOOLS_CLI = env.cli
  delete require.cache[modulePath]
  const loaded = require(modulePath)
  try {
    return run(loaded)
  } finally {
    if (previous.project === undefined) delete process.env.MINIPROGRAM_BROWSER_GATE_PROJECT
    else process.env.MINIPROGRAM_BROWSER_GATE_PROJECT = previous.project
    if (previous.cli === undefined) delete process.env.WECHAT_DEVTOOLS_CLI
    else process.env.WECHAT_DEVTOOLS_CLI = previous.cli
  }
}

test('real DevTools gates do not fall back to machine-specific paths', () => {
  withHarnessEnv({}, (harness) => {
    assert.equal(harness.resolveProject(), '')
    assert.equal(harness.resolveCliPath(), '')
  })
  const source = fs.readFileSync(require.resolve('../scripts/lib/e2e-harness.cjs'), 'utf8')
  assert.doesNotMatch(source, /DEFAULT_PROJECTS|const fallback/u)
})

test('real DevTools gates use only the explicitly configured synthetic project', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-gate-project-'))
  fs.writeFileSync(path.join(project, 'project.config.json'), '{"appid":"touristappid"}')
  try {
    withHarnessEnv({ project, cli: '/opt/wechat-devtools/cli' }, (harness) => {
      assert.equal(harness.resolveProject(), project)
      assert.equal(harness.resolveCliPath(), '/opt/wechat-devtools/cli')
    })
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

test('real DevTools gates reject non-tourist AppIDs before opening DevTools', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-private-gate-project-'))
  fs.writeFileSync(path.join(project, 'project.config.json'), '{"appid":"wx-private-placeholder"}')
  try {
    withHarnessEnv({ project, cli: '/opt/wechat-devtools/cli' }, (harness) => {
      assert.equal(harness.resolveProject(), '')
    })
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

test('real DevTools gates ignore ambient target and endpoint overrides', (t) => {
  const overrides = ['WECHAT_DEVTOOLS_PROJECT', 'WECHAT_DEVTOOLS_PROJECT_MAP', 'WECHAT_DEVTOOLS_PORT', 'WECHAT_AUTO_PORT']
  const previous = Object.fromEntries(overrides.map((key) => [key, process.env[key]]))
  t.after(() => {
    for (const key of overrides) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
    delete require.cache[require.resolve('../scripts/lib/e2e-harness.cjs')]
  })
  for (const key of overrides) process.env[key] = 'synthetic-unrelated-target'
  let childEnv
  t.mock.method(childProcess, 'spawnSync', (_command, _args, options) => {
    childEnv = options.env
    return { status: 0, stdout: '{}' }
  })
  withHarnessEnv({ cli: '/synthetic/cli' }, ({ createHarness }) => {
    createHarness().runCli(['--help'])
    for (const key of overrides) assert.equal(childEnv[key], '', key)
    assert.equal(childEnv.WECHAT_DEVTOOLS_CLI, '/synthetic/cli')
  })
})

test('gate success requires valid JSON and a successful process and payload', () => {
  const { isSuccessfulResult } = require('../scripts/lib/e2e-harness.cjs')
  assert.equal(isSuccessfulResult({ status: 0 }, { path: 'pages/index/index' }), true)
  for (const payload of [null, { _parseError: 'no-json' }, { ok: false }, { error: 'failed' }]) {
    assert.equal(isSuccessfulResult({ status: 0 }, payload), false)
  }
  assert.equal(isSuccessfulResult({ status: 1 }, { ok: true }), false)
  assert.equal(isSuccessfulResult({ status: null }, { ok: true }), false)
})

test('gate cleanup requires verified runtime closure, but accepts an attached-session unbind', (t) => {
  let payload = { runtimeShutdown: true, cleanup: { closeVerified: false } }
  t.mock.method(childProcess, 'spawnSync', () => ({ status: 0, stdout: JSON.stringify(payload) }))
  withHarnessEnv({}, ({ createHarness }) => {
    const h = createHarness()
    assert.equal(h.installSessionCleanup(['synthetic-owner']).run()[0].ok, false)
    payload = { runtimeShutdown: true, cleanup: { closeVerified: true } }
    assert.equal(h.installSessionCleanup(['synthetic-owner']).run()[0].ok, true)
    payload = { runtimeShutdown: false, cleanup: { runtimeShutdown: false } }
    assert.equal(h.installSessionCleanup(['synthetic-attached']).run()[0].ok, true)
  })
  t.after(() => { delete require.cache[require.resolve('../scripts/lib/e2e-harness.cjs')] })
})

test('L0 interaction gate requires a real actionable ref and hard click success', () => {
  const source = fs.readFileSync(require.resolve('../scripts/l0-e2e.cjs'), 'utf8')
  assert.doesNotMatch(source, /skipped-no-button|click-failed-soft/u)
  assert.match(source, /navigator/u)
  assert.match(source, /installSessionCleanup/u)
  for (const requiredCase of [
    'interaction.swipe-view',
    'interaction.swipe-view-right',
    'interaction.swipe-native',
    'interaction.longpress',
    'interaction.transient',
    'interaction.scroll-container',
    'interaction.scroll-page',
    'navigation.back',
  ]) {
    assert.match(source, new RegExp(requiredCase.replace('.', '\\.'), 'u'), requiredCase)
  }
  assert.match(source, /'--await', 'change'/u)
})
