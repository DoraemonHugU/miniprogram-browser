const test = require('node:test')
const assert = require('node:assert/strict')

const {
  detectRuntimeOS,
  detectWsl,
  detectDevtoolsHost,
  resolveEnvironment,
} = require('../dist/lib/platform.js')

test('detectRuntimeOS 包 process.platform', () => {
  assert.ok(['win32', 'darwin', 'linux'].includes(detectRuntimeOS()))
})

test('detectWsl: 含 microsoft 的版本串 → true', () => {
  assert.equal(detectWsl('4.19.128-microsoft-standard-WSL2'), true)
  assert.equal(detectWsl('Linux version 5.15.0-microsoft-standard-WSL2'), true)
})

test('detectWsl: 普通 linux 版本串 → false', () => {
  assert.equal(detectWsl('5.15.0-ubuntu-generic'), false)
})

test('detectWsl: 非 linux 宿主由 detectRuntimeOS 守卫（本机为 linux，仅验证不读真实 /proc/version 时行为）', () => {
  // 注：OS 守卫分支（process.platform !== 'linux' → false）在 linux CI 上无法触发，
  // 由 resolveEnvironment 的 needsBridge 测试间接覆盖同一逻辑。这里只验证注入文本路径。
  assert.equal(detectWsl('5.15.0-ubuntu-generic'), false)
})

test('detectWsl: 缺省读真实 /proc/version，不抛异常', () => {
  assert.doesNotThrow(() => detectWsl())
})

test('detectDevtoolsHost: .bat 结尾 → win32', () => {
  assert.equal(detectDevtoolsHost({ cliPath: 'C:\\\\WeChat\\\\cli.bat' }), 'win32')
  assert.equal(detectDevtoolsHost({ cliPath: '/mnt/c/WeChat/cli.bat' }), 'win32')
})

test('detectDevtoolsHost: 其他 → darwin', () => {
  assert.equal(detectDevtoolsHost({ cliPath: '/Applications/wechatdevtools/bin/cli' }), 'darwin')
  assert.equal(detectDevtoolsHost({}), 'darwin')
  assert.equal(detectDevtoolsHost(undefined), 'darwin')
})

// 注：runtime 维度来自真实 process.platform，不可注入，故 mac/win 用例只断言可注入维度。
test('resolveEnvironment: mac DevTools CLI（非 .bat）→ devtoolsHost=darwin，非 WSL 非桥接', () => {
  const env = resolveEnvironment({ cliPath: '/Applications/wechatdevtools/bin/cli' }, { readProcVersion: 'Darwin Kernel Version 23.0' })
  assert.equal(env.devtoolsHost, 'darwin')
  assert.equal(env.isWsl, false)
  assert.equal(env.needsBridge, false)
})

test('resolveEnvironment: Windows DevTools CLI（.bat）→ devtoolsHost=win32，非 WSL', () => {
  // 本机 runtime=linux，devtoolsHost=win32 → needsBridge=true；只断言可注入维度。
  const env = resolveEnvironment({ cliPath: 'C:\\\\WeChat\\\\cli.bat' }, { readProcVersion: 'Windows NT 10.0' })
  assert.equal(env.devtoolsHost, 'win32')
  assert.equal(env.isWsl, false)
})

test('resolveEnvironment: WSL = linux + win32 + needsBridge', () => {
  const env = resolveEnvironment(
    { cliPath: 'C:\\\\WeChat\\\\cli.bat' },
    { readProcVersion: '5.15.0-microsoft-standard-WSL2' }
  )
  assert.deepEqual(env, {
    runtime: 'linux',
    devtoolsHost: 'win32',
    isWsl: true,
    needsBridge: true,
  })
})

test('resolveEnvironment: 裸 linux + mac DevTools，非 WSL 非桥接', () => {
  const env = resolveEnvironment(
    { cliPath: '/Applications/wechatdevtools/bin/cli' },
    { readProcVersion: '5.15.0-ubuntu-generic' }
  )
  assert.equal(env.runtime, 'linux')
  assert.equal(env.devtoolsHost, 'darwin')
  assert.equal(env.isWsl, false)
  assert.equal(env.needsBridge, false)
})
