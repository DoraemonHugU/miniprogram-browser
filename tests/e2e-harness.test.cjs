const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

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
  fs.writeFileSync(path.join(project, 'project.config.json'), '{}')
  try {
    withHarnessEnv({ project, cli: '/opt/wechat-devtools/cli' }, (harness) => {
      assert.equal(harness.resolveProject(), project)
      assert.equal(harness.resolveCliPath(), '/opt/wechat-devtools/cli')
    })
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

test('L0 interaction gate requires a real actionable ref and hard click success', () => {
  const source = fs.readFileSync(require.resolve('../scripts/l0-e2e.cjs'), 'utf8')
  assert.doesNotMatch(source, /skipped-no-button|click-failed-soft/u)
  assert.match(source, /navigator/u)
})
