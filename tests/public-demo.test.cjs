const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const { inspectProjectStructure } = require('../dist/lib/app-inspect.js')

const repoRoot = path.resolve(__dirname, '..')
const demoRoot = path.join(repoRoot, 'demo', 'public-demo')
const expectedPages = [
  'pages/index/index',
  'pages/controls/index',
  'pages/lists/index',
  'pages/navigation/index',
  'pages/detail/index',
  'pages/interaction/index',
]

function read(relativePath) {
  return fs.readFileSync(path.join(demoRoot, relativePath), 'utf8')
}

test('public demo uses a standard synthetic native mini program structure', () => {
  const projectConfig = JSON.parse(read('project.config.json'))
  const appConfig = JSON.parse(read('app.json'))

  assert.equal(projectConfig.appid, 'touristappid')
  assert.deepEqual(appConfig.pages, expectedPages)

  const pageSources = []
  for (const pageRoute of expectedPages) {
    for (const extension of ['js', 'json', 'wxml', 'wxss']) {
      const relativePath = `${pageRoute}.${extension}`
      assert.equal(fs.existsSync(path.join(demoRoot, relativePath)), true, relativePath)
      const source = read(relativePath)
      pageSources.push(source)
      if (extension === 'json') {
        assert.doesNotThrow(() => JSON.parse(source), relativePath)
      } else if (extension === 'js') {
        assert.doesNotThrow(() => new vm.Script(source, { filename: relativePath }), relativePath)
      }
    }
  }

  const publicSource = pageSources.join('\n')
  assert.doesNotMatch(publicSource, /wx\.(?:request|uploadFile|downloadFile|connectSocket|getStorage|setStorage)/u)
  assert.doesNotMatch(publicSource, /https?:\/\//u)
  assert.doesNotMatch(publicSource, /\bwx[a-f0-9]{16}\b/iu)
})

test('public demo controls and list pages expose observable interaction states', () => {
  const controlsWxml = read('pages/controls/index.wxml')
  const controlsJs = read('pages/controls/index.js')
  for (const tag of ['input', 'button', 'switch', 'checkbox', 'radio']) {
    assert.match(controlsWxml, new RegExp(`<${tag}\\b`, 'u'), tag)
  }
  assert.match(controlsWxml, /\{\{[^}]+\}\}/u)
  assert.match(controlsJs, /setData\s*\(/u)

  const listsWxml = read('pages/lists/index.wxml')
  const listsJs = read('pages/lists/index.js')
  assert.match(listsWxml, /wx:for=/u)
  assert.match(listsWxml, /wx:key=/u)
  assert.ok((listsWxml.match(/<button\b/gu) || []).length >= 3)
  assert.match(listsJs, /setData\s*\(/u)
})

test('public demo interaction page covers scrolling, gestures, modal and transient state', () => {
  const wxml = read('pages/interaction/index.wxml')
  const source = read('pages/interaction/index.js')

  assert.match(wxml, /<scroll-view\b[^>]*scroll-y/u)
  assert.match(wxml, /<swiper\b/u)
  assert.match(wxml, /bindlongpress=/u)
  assert.match(source, /wx\.showModal\s*\(/u)
  assert.match(source, /setTimeout\s*\(/u)
  assert.match(wxml, /interaction-bottom/u)
})

test('public demo static route graph covers catalog navigation and detail back', async () => {
  const inspection = await inspectProjectStructure({
    projectPath: demoRoot,
    sections: ['pages', 'staticEdges', 'staticSummary'],
  })

  assert.deepEqual(inspection.pages, expectedPages)
  const edges = inspection.staticEdges || []
  for (const target of [
    'pages/controls/index',
    'pages/lists/index',
    'pages/navigation/index',
    'pages/detail/index',
    'pages/interaction/index',
  ]) {
    assert.ok(edges.some((edge) => edge.to === target), target)
  }
  assert.equal(inspection.staticSummary.hasNavigateTo, true)
  assert.equal(inspection.staticSummary.hasNavigateBack, true)
})

test('public demo catalog exposes standard navigator controls to automation', () => {
  const indexWxml = read('pages/index/index.wxml')
  assert.equal((indexWxml.match(/<navigator\b/gu) || []).length, 4)
  assert.doesNotMatch(indexWxml, /bindtap=/u)
})
