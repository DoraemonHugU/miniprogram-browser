const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  allocateTempScreenshotPath,
  buildScreenshotPathNotice,
  isPathInside,
  resolveFilesystemPath,
  resolveScreenshotOutputPath,
} = require('../dist/lib/temp-artifacts.js')

test('resolveFilesystemPath uses explicit POSIX and Windows path semantics', () => {
  assert.equal(
    resolveFilesystemPath('shots/page.png', '/workspace/demo', path.posix),
    '/workspace/demo/shots/page.png',
  )
  assert.equal(
    resolveFilesystemPath('/var/tmp/page.png', '/workspace/demo', path.posix),
    '/var/tmp/page.png',
  )
  assert.equal(
    resolveFilesystemPath('shots\\page.png', 'C:\\workspace\\demo', path.win32),
    'C:\\workspace\\demo\\shots\\page.png',
  )
  assert.equal(
    resolveFilesystemPath('D:\\captures\\page.png', 'C:\\workspace\\demo', path.win32),
    'D:\\captures\\page.png',
  )
})

test('resolveScreenshotOutputPath keeps the default in the configured temporary directory', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-output-path-'))
  const temporaryDirectory = path.join(root, 'temporary')
  try {
    const targetPath = await resolveScreenshotOutputPath('', {
      directory: temporaryDirectory,
      projectName: 'demo',
      route: '/pages/index/index',
      mode: 'page',
    })
    assert.equal(path.dirname(targetPath), temporaryDirectory)
    assert.equal(path.basename(targetPath), 'mpb-demo-index-page.png')
    assert.equal(fs.existsSync(targetPath), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('resolveScreenshotOutputPath resolves explicit files and creates missing parents', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-output-path-'))
  try {
    const relativeTarget = await resolveScreenshotOutputPath('captures/page.png', { cwd: root })
    assert.equal(relativeTarget, path.join(root, 'captures', 'page.png'))
    assert.equal(fs.statSync(path.dirname(relativeTarget)).isDirectory(), true)

    const absoluteTarget = path.join(root, 'absolute', 'page.png')
    assert.equal(await resolveScreenshotOutputPath(absoluteTarget, { cwd: path.join(root, 'ignored') }), absoluteTarget)
    assert.equal(fs.statSync(path.dirname(absoluteTarget)).isDirectory(), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('resolveScreenshotOutputPath allocates generated names inside explicit directories', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-output-path-'))
  const existingDirectory = path.join(root, 'existing')
  fs.mkdirSync(existingDirectory)
  try {
    const common = {
      cwd: root,
      projectName: 'demo',
      route: '/pages/index/index',
      mode: 'page',
    }
    const existingTarget = await resolveScreenshotOutputPath('existing', common)
    assert.equal(path.dirname(existingTarget), existingDirectory)

    const newDirectoryInput = `new-directory${path.sep}`
    const newTarget = await resolveScreenshotOutputPath(newDirectoryInput, common)
    assert.equal(path.dirname(newTarget), path.join(root, 'new-directory'))
    assert.equal(fs.statSync(path.dirname(newTarget)).isDirectory(), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('isPathInside distinguishes project-local and external screenshot paths', () => {
  const projectPath = path.join(os.tmpdir(), 'demo-project')
  assert.equal(isPathInside(path.join(projectPath, 'screenshots', 'page.png'), projectPath), true)
  assert.equal(isPathInside(path.join(os.tmpdir(), 'page.png'), projectPath), false)
  assert.equal(isPathInside(projectPath, projectPath), true)
  assert.match(buildScreenshotPathNotice(path.join(projectPath, 'page.png'), projectPath), /重新编译|项目目录外/u)
  assert.equal(buildScreenshotPathNotice(path.join(os.tmpdir(), 'page.png'), projectPath), '')
})

test('allocateTempScreenshotPath keeps default names short and readable', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-artifacts-'))
  try {
    const targetPath = await allocateTempScreenshotPath({
      directory,
      projectName: 'shop',
      route: '/pages/home/index',
      mode: 'layout',
    })
    const filename = path.basename(targetPath)
    assert.equal(filename, 'mpb-shop-home-layout.png')
    assert.ok(filename.length <= 64, filename)
    assert.equal(fs.existsSync(targetPath), true)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('allocateTempScreenshotPath keeps a readable page token for non-index routes', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-artifacts-'))
  try {
    const targetPath = await allocateTempScreenshotPath({
      directory,
      projectName: 'shop',
      route: '/pages/orders/detail',
      mode: 'page',
    })
    assert.equal(path.basename(targetPath), 'mpb-shop-orders-detail-page.png')
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('allocateTempScreenshotPath increments an existing base name without overwriting', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-artifacts-'))
  try {
    const options = {
      directory,
      projectName: 'shop',
      route: '/pages/home/index',
      mode: 'layout',
    }
    const first = await allocateTempScreenshotPath(options)
    fs.writeFileSync(first, 'first')
    const second = await allocateTempScreenshotPath(options)
    assert.equal(second, `${first.slice(0, -4)}-1.png`)
    assert.equal(fs.readFileSync(first, 'utf8'), 'first')
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('allocateTempScreenshotPath is safe for concurrent same-name allocations', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-artifacts-'))
  try {
    const options = {
      directory,
      projectName: 'shop',
      route: '/pages/home/index',
      mode: 'layout',
    }
    const paths = await Promise.all(Array.from({ length: 6 }, () => allocateTempScreenshotPath(options)))
    assert.equal(new Set(paths).size, 6)
    const baseStem = paths
      .map((item) => path.basename(item, '.png'))
      .find((item) => !/-[1-5]$/u.test(item))
    assert.ok(baseStem)
    assert.deepEqual(
      paths.map((item) => path.basename(item)).sort(),
      [baseStem, 1, 2, 3, 4, 5].map((suffix) => `${baseStem}${suffix === baseStem ? '' : `-${suffix}`}.png`).sort(),
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
