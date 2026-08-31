const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { mock } = test

const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-session-privacy-home-'))
process.env.HOME = homeDir
process.env.USERPROFILE = homeDir

const readFileCalls = []
const existsSyncCalls = []
const actualReadFile = fs.promises.readFile.bind(fs.promises)
const actualExistsSync = fs.existsSync.bind(fs)
mock.method(fs.promises, 'readFile', async (...args) => {
  readFileCalls.push(path.resolve(String(args[0])))
  return actualReadFile(...args)
})
mock.method(fs, 'existsSync', (...args) => {
  existsSyncCalls.push(path.resolve(String(args[0])))
  return actualExistsSync(...args)
})

const {
  createDefaultConfig,
  createEmptySessionState,
  loadOtherSessionConfigs,
  saveSessionState,
} = require('../dist/lib/session-store.js')

function configFor(projectPath, sessionRegistryFile) {
  return {
    ...createDefaultConfig('/synthetic/repo'),
    projectPath,
    sessionRegistryFile,
  }
}

function projectSessionFile(projectPath, sessionName) {
  const projectKey = createHash('sha1')
    .update(path.resolve(projectPath))
    .digest('hex')
    .slice(0, 12)
  return path.join(homeDir, '.miniprogram-browser', 'projects', projectKey, 'sessions', `${sessionName}.json`)
}

function resetFileAccessCalls() {
  readFileCalls.length = 0
  existsSyncCalls.length = 0
}

test.after(async () => {
  mock.restoreAll()
  await fs.promises.rm(homeDir, { recursive: true, force: true })
})

test('scoped session loading skips other-project JSON before reading it', async () => {
  const registryFile = path.join(homeDir, 'registry-scoped.json')
  const projectA = '/synthetic/project-a'
  const projectB = '/synthetic/project-b'

  await saveSessionState(createEmptySessionState({
    sessionName: 'secret-other',
    config: configFor(projectB, registryFile),
  }))

  resetFileAccessCalls()
  const configs = await loadOtherSessionConfigs(configFor(projectA, registryFile), 'current')
  assert.deepEqual(configs, [])
  const otherSessionFile = projectSessionFile(projectB, 'secret-other')
  assert.equal(readFileCalls.includes(otherSessionFile), false)
  assert.equal(existsSyncCalls.includes(otherSessionFile), false)
})

test('global session loading still includes registered projects without a projectPath', async () => {
  const registryFile = path.join(homeDir, 'registry-global.json')
  const projectB = '/synthetic/project-b-global'

  await saveSessionState(createEmptySessionState({
    sessionName: 'global-session',
    config: configFor(projectB, registryFile),
  }))

  const configs = await loadOtherSessionConfigs({
    ...createDefaultConfig('/synthetic/repo'),
    projectPath: '',
    sessionRegistryFile: registryFile,
  }, 'current')
  assert.deepEqual(configs.map((item) => ({ name: item.name, projectPath: item.config.projectPath })), [
    { name: 'global-session', projectPath: path.resolve(projectB) },
  ])
})

test('scoped session loading skips an external legacy directory', async () => {
  const registryFile = path.join(homeDir, 'registry-legacy.json')
  const legacyDir = path.join(homeDir, 'legacy-sessions')
  await fs.promises.mkdir(legacyDir, { recursive: true })
  await fs.promises.writeFile(path.join(legacyDir, 'secret-legacy.json'), JSON.stringify({
    name: 'secret-legacy',
    config: { projectPath: '/synthetic/project-b-legacy' },
  }))

  resetFileAccessCalls()
  const configs = await loadOtherSessionConfigs({
    ...configFor('/synthetic/project-a-legacy', registryFile),
    legacySessionDir: legacyDir,
  }, 'current')
  assert.deepEqual(configs, [])
  const legacySessionFile = path.join(legacyDir, 'secret-legacy.json')
  assert.equal(readFileCalls.includes(legacySessionFile), false)
  assert.equal(existsSyncCalls.includes(legacyDir), false)
})
