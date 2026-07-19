const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '..')
const script = path.join(repoRoot, 'scripts', 'l0-e2e.cjs')

test('l0-e2e skips when GATE_SKIP=1', () => {
  const result = spawnSync(process.execPath, [script], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      MINIPROGRAM_BROWSER_GATE_SKIP: '1',
      WECHAT_DEVTOOLS_CLI: '',
    },
  })
  assert.equal(result.status, 2)
  assert.match(String(result.stderr || ''), /SKIP/i)
})

test('l0-e2e skips when CLI path missing', () => {
  const result = spawnSync(process.execPath, [script], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      MINIPROGRAM_BROWSER_GATE_SKIP: '',
      WECHAT_DEVTOOLS_CLI: '/tmp/not-a-devtools-cli-xyz',
      MINIPROGRAM_BROWSER_GATE_PROJECT: '/tmp/no-project',
    },
  })
  assert.equal(result.status, 2)
  assert.match(String(result.stderr || ''), /SKIP/i)
})
