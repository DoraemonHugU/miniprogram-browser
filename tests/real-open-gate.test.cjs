const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '..')
const gateScript = path.join(repoRoot, 'scripts', 'real-open-gate.cjs')

test('real-open-gate skips when GATE_SKIP=1', () => {
  const result = spawnSync(process.execPath, [gateScript], {
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

test('real-open-gate skips when CLI missing', () => {
  const result = spawnSync(process.execPath, [gateScript], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      MINIPROGRAM_BROWSER_GATE_SKIP: '',
      WECHAT_DEVTOOLS_CLI: '/tmp/not-a-real-devtools-cli-path',
      MINIPROGRAM_BROWSER_GATE_PROJECT: '/tmp/not-a-project',
    },
  })
  assert.equal(result.status, 2)
  assert.match(String(result.stderr || ''), /SKIP/i)
})
