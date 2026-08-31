const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const packageJson = require('../package.json')

test('package requires the maintained Node LTS baseline', () => {
  assert.equal(packageJson.engines.node, '>=22')
  assert.equal(fs.readFileSync(path.join(__dirname, '..', '.nvmrc'), 'utf8').trim(), '22')
})

test('miniprogram-automator shares the compatible Jimp v0 runtime', () => {
  const Jimp = require('jimp')
  const automatorRoot = path.dirname(require.resolve('miniprogram-automator/package.json'))
  const automatorJimpPath = require.resolve('jimp', { paths: [automatorRoot] })

  assert.equal(packageJson.dependencies.jimp, '0.22.12')
  assert.equal(packageJson.overrides['miniprogram-automator'].jimp, '0.22.12')
  assert.deepEqual(packageJson.bundleDependencies, ['miniprogram-automator'])
  assert.equal(automatorJimpPath, require.resolve('jimp'))
  assert.equal(typeof Jimp.read, 'function')
  assert.equal(typeof Jimp.rgbaToInt, 'function')
})
