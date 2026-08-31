const test = require('node:test')
const assert = require('node:assert/strict')
const { existsSync } = require('node:fs')
const path = require('node:path')

const packageJson = require('../package.json')

const repoRoot = path.resolve(__dirname, '..')

test('package bin points at the compiled TypeScript CLI entrypoint', () => {
  const binPath = packageJson.bin && packageJson.bin['miniprogram-browser']

  assert.equal(binPath, 'dist/miniprogram-browser.js')
  assert.equal(existsSync(path.join(repoRoot, binPath)), true)
})
