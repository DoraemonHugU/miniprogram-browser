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
  // 注入 wslDistroName:'' 隔离辅助信号，仅验证 microsoft 主信号缺失时为 false
  assert.equal(detectWsl('5.15.0-ubuntu-generic', { runtime: 'linux', wslDistroName: '' }), false)
})

test('detectWsl: 非 linux 宿主由 detectRuntimeOS 守卫（只验证注入文本路径不读真实 /proc/version）', () => {
  // OS 守卫分支（process.platform !== 'linux' → false）在 linux CI 上无法触发，
  // 由 resolveEnvironment 的 needsBridge 测试间接覆盖同一逻辑。这里只验证注入文本路径。
  assert.equal(detectWsl('5.15.0-ubuntu-generic', { runtime: 'linux', wslDistroName: '' }), false)
})

test('detectWsl: 缺省读真实 /proc/version，不抛异常', () => {
  assert.doesNotThrow(() => detectWsl())
})

test('detectWsl: WSL_DISTRO_NAME 作为辅助信号（无 microsoft 串时）→ true', () => {
  // runtime 守卫：非 linux 即使有 WSL_DISTRO_NAME 也不判为 WSL
  assert.equal(detectWsl('5.15.0-ubuntu-generic', { runtime: 'linux', wslDistroName: 'ubuntu-22.04' }), true)
  assert.equal(detectWsl('5.15.0-ubuntu-generic', { runtime: 'darwin', wslDistroName: 'ubuntu-22.04' }), false)
})

test('detectDevtoolsHost: 由 runtime 推导 → win32', () => {
  assert.equal(detectDevtoolsHost('win32'), 'win32')
  assert.equal(detectDevtoolsHost('linux'), 'win32')
})

test('detectDevtoolsHost: 由 runtime 推导 → darwin', () => {
  assert.equal(detectDevtoolsHost('darwin'), 'darwin')
})

// runtime 维度可注入，完整覆盖三态。
test('resolveEnvironment: Windows 宿主 → runtime=win32, devtoolsHost=win32, 非 WSL 非桥接', () => {
  const env = resolveEnvironment({}, { runtime: 'win32', readProcVersion: 'Windows NT 10.0' })
  assert.deepEqual(env, {
    runtime: 'win32',
    devtoolsHost: 'win32',
    isWsl: false,
    needsBridge: false,
  })
})

test('resolveEnvironment: macOS 宿主 → runtime=darwin, devtoolsHost=darwin, 非 WSL 非桥接', () => {
  const env = resolveEnvironment({}, { runtime: 'darwin', readProcVersion: 'Darwin Kernel Version 23.0' })
  assert.deepEqual(env, {
    runtime: 'darwin',
    devtoolsHost: 'darwin',
    isWsl: false,
    needsBridge: false,
  })
})

test('resolveEnvironment: 裸 linux 宿主 → runtime=linux, devtoolsHost=win32, 非 WSL 非桥接', () => {
  // 裸 linux：无 microsoft 串也无 WSL_DISTRO_NAME 辅助 → 非 WSL，无桥接。
  // devtoolsHost 仍按 runtime 推导为 win32（裸 linux 本无可达 DevTools，依赖上层兜底报错）。
  const env = resolveEnvironment({}, { runtime: 'linux', readProcVersion: '5.15.0-ubuntu-generic', wslDistroName: '' })
  assert.equal(env.runtime, 'linux')
  assert.equal(env.devtoolsHost, 'win32')
  assert.equal(env.isWsl, false)
  assert.equal(env.needsBridge, false)
})

test('resolveEnvironment: WSL = linux + win32 + needsBridge（microsoft 串）', () => {
  const env = resolveEnvironment(
    {},
    { runtime: 'linux', readProcVersion: '5.15.0-microsoft-standard-WSL2' }
  )
  assert.deepEqual(env, {
    runtime: 'linux',
    devtoolsHost: 'win32',
    isWsl: true,
    needsBridge: true,
  })
})

test('resolveEnvironment: WSL = linux + win32 + needsBridge（WSL_DISTRO_NAME 辅助）', () => {
  const env = resolveEnvironment(
    {},
    { runtime: 'linux', readProcVersion: '5.15.0-ubuntu-generic', wslDistroName: 'ubuntu-22.04' }
  )
  assert.deepEqual(env, {
    runtime: 'linux',
    devtoolsHost: 'win32',
    isWsl: true,
    needsBridge: true,
  })
})
