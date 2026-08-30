const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')

const repoRoot = path.resolve(__dirname, '..')
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'miniprogram-browser-install-'))
const consumerRoot = path.join(tempRoot, 'consumer')

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const details = options.capture ? `\n${result.stdout || ''}${result.stderr || ''}` : ''
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status}${details}`)
  }
  return result.stdout || ''
}

try {
  fs.mkdirSync(consumerRoot)
  fs.writeFileSync(path.join(consumerRoot, 'package.json'), JSON.stringify({
    name: 'miniprogram-browser-install-gate',
    version: '1.0.0',
    private: true,
  }, null, 2) + '\n')

  const packOutput = run(npmCommand, [
    'pack',
    '--json',
    '--pack-destination',
    tempRoot,
  ], { capture: true })
  const packResult = JSON.parse(packOutput)[0]
  const tarballPath = path.join(tempRoot, packResult.filename)

  run(npmCommand, [
    'install',
    '--ignore-scripts',
    '--audit=false',
    '--fund=false',
    tarballPath,
  ], { cwd: consumerRoot })

  const consumerRequire = createRequire(path.join(consumerRoot, 'package.json'))
  const cliPackage = consumerRequire('miniprogram-browser/package.json')
  const cliRoot = path.dirname(consumerRequire.resolve('miniprogram-browser/package.json'))
  const automatorRoot = path.dirname(consumerRequire.resolve('miniprogram-browser/node_modules/miniprogram-automator/package.json'))
  const automatorRequire = createRequire(path.join(automatorRoot, 'package.json'))
  const cliJimp = consumerRequire('miniprogram-browser/node_modules/jimp/package.json')
  const automatorJimp = automatorRequire('jimp/package.json')

  assert.equal(cliPackage.version, require('../package.json').version)
  assert.equal(cliJimp.version, '0.22.12')
  assert.equal(automatorJimp.version, '0.22.12')
  assert.equal(
    automatorRequire.resolve('jimp/package.json'),
    consumerRequire.resolve('miniprogram-browser/node_modules/jimp/package.json'),
  )

  assert.equal(
    run(npmCommand, ['exec', '--offline', '--', 'miniprogram-browser', 'version'], { cwd: consumerRoot, capture: true }).trim(),
    cliPackage.version,
  )
  assert.match(
    run(npmCommand, ['exec', '--offline', '--', 'miniprogram-browser', 'help'], { cwd: consumerRoot, capture: true }),
    /核心命令（优先使用）:[\s\S]*\n  open\s/u,
  )

  console.log(JSON.stringify({
    ok: true,
    node: process.version,
    platform: process.platform,
    version: cliPackage.version,
    tarballBytes: packResult.size,
    tarballFiles: packResult.entryCount,
    bundledDependencies: packResult.bundled.length,
    project: path.basename(cliRoot),
  }, null, 2))
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
