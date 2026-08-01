const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  allocateTempScreenshotPath,
} = require('../dist/lib/temp-artifacts.js')

test('allocateTempScreenshotPath keeps default names short and readable', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-artifacts-'))
  try {
    const targetPath = await allocateTempScreenshotPath({
      directory,
      projectName: 'shop',
      sessionName: 'work',
      route: '/pages/home/index',
      mode: 'layout',
    })
    const filename = path.basename(targetPath)
    assert.match(filename, /^mpb-shop-work-home-index-[a-f0-9]{4}-layout\.png$/u)
    assert.ok(filename.length <= 64, filename)
    assert.equal(fs.existsSync(targetPath), true)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('allocateTempScreenshotPath bounds long project, session, and route tokens', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-artifacts-'))
  try {
    const targetPath = await allocateTempScreenshotPath({
      directory,
      projectName: 'a-project-name-that-is-deliberately-long',
      sessionName: 'a-session-name-that-is-deliberately-long',
      route: '/pages/a-very-long-page-name/detail/with-many-segments',
      mode: 'visual-probe',
    })
    assert.ok(path.basename(targetPath).length <= 64, path.basename(targetPath))
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
      sessionName: 'work',
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
      sessionName: 'work',
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
