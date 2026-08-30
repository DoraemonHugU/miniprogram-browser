const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '..')
const expectedPages = [
  'pages/index/index',
  'pages/controls/index',
  'pages/lists/index',
  'pages/navigation/index',
  'pages/detail/index',
]

function root(framework) {
  return path.join(repoRoot, 'demo', `${framework}-demo`)
}

function read(framework, relativePath) {
  return fs.readFileSync(path.join(root(framework), relativePath), 'utf8')
}

function readJson(framework, relativePath) {
  return JSON.parse(read(framework, relativePath))
}

function sourceTree(framework, extensions) {
  const files = []
  const pending = [path.join(root(framework), 'src')]
  while (pending.length > 0) {
    const current = pending.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) {
        pending.push(absolute)
      } else if (extensions.some((extension) => entry.name.endsWith(extension))) {
        files.push(absolute)
      }
    }
  }
  return files.map((file) => fs.readFileSync(file, 'utf8')).join('\n')
}

function assertSyntheticSource(source) {
  assert.doesNotMatch(source, /https?:\/\//u)
  assert.doesNotMatch(source, /\bwx[a-f0-9]{16}\b/iu)
  assert.doesNotMatch(
    source,
    /(?:wx|Taro|uni)\.(?:request|uploadFile|downloadFile|connectSocket|getStorage|setStorage)/u,
  )
}

function assertBuiltMiniProgram(framework) {
  const projectConfig = readJson(framework, 'project.config.json')
  const outputRoot = path.join(root(framework), projectConfig.miniprogramRoot)
  const appConfig = JSON.parse(fs.readFileSync(path.join(outputRoot, 'app.json'), 'utf8'))

  assert.deepEqual(appConfig.pages, expectedPages)
  assert.equal(fs.existsSync(path.join(outputRoot, 'app.wxss')), true)
  for (const page of expectedPages) {
    for (const extension of ['js', 'json', 'wxml']) {
      const output = path.join(outputRoot, `${page}.${extension}`)
      assert.equal(fs.existsSync(output), true, output)
    }
  }
}

test('Taro demo is a reproducible React TypeScript WeChat project', () => {
  const projectConfig = readJson('taro', 'project.config.json')
  const packageJson = readJson('taro', 'package.json')
  const appConfig = read('taro', 'src/app.config.ts')

  assert.equal(projectConfig.appid, 'touristappid')
  assert.equal(projectConfig.miniprogramRoot, 'dist/')
  assert.match(packageJson.scripts['build:weapp'], /taro build --type weapp/u)
  assert.equal(packageJson.devDependencies['@tarojs/cli'], '4.2.1')
  for (const dependency of ['@tarojs/taro', '@tarojs/react', '@tarojs/components']) {
    assert.equal(packageJson.dependencies[dependency], '4.2.1')
  }
  for (const page of expectedPages) {
    assert.match(appConfig, new RegExp(`['"]${page}['"]`, 'u'), page)
    assert.equal(fs.existsSync(path.join(root('taro'), 'src', `${page}.tsx`)), true, page)
  }
})

test('uni-app demo is a reproducible Vue 3 Vite WeChat project', () => {
  const projectConfig = readJson('uni-app', 'project.config.json')
  const packageJson = readJson('uni-app', 'package.json')
  const pagesConfig = readJson('uni-app', 'src/pages.json')
  const manifest = readJson('uni-app', 'src/manifest.json')

  assert.equal(projectConfig.appid, 'touristappid')
  assert.equal(projectConfig.miniprogramRoot, 'dist/build/mp-weixin/')
  assert.equal(manifest.uniStatistics.enable, false)
  assert.equal(manifest['mp-weixin'].uniStatistics.enable, false)
  assert.match(packageJson.scripts['build:mp-weixin'], /uni build -p mp-weixin/u)
  assert.match(packageJson.scripts['build:mp-weixin'], /remove-network-preload\.mjs/u)
  assert.match(packageJson.dependencies.vue, /^\^?3\./u)
  assert.equal(
    packageJson.dependencies['@dcloudio/uni-app'],
    packageJson.dependencies['@dcloudio/uni-mp-weixin'],
  )
  assert.equal(
    packageJson.dependencies['@dcloudio/uni-app'],
    packageJson.devDependencies['@dcloudio/vite-plugin-uni'],
  )
  assert.deepEqual(
    pagesConfig.pages.map((page) => page.path),
    expectedPages,
  )
  for (const page of expectedPages) {
    assert.equal(fs.existsSync(path.join(root('uni-app'), 'src', `${page}.vue`)), true, page)
  }
})

test('framework demos expose the same controls, repeated lists and navigation behaviors', () => {
  const taroSource = sourceTree('taro', ['.ts', '.tsx'])
  for (const component of ['Input', 'Button', 'Switch', 'Checkbox', 'Radio']) {
    assert.match(taroSource, new RegExp(`<${component}\\b`, 'u'), component)
  }
  assert.match(taroSource, /\.map\s*\(/u)
  assert.match(taroSource, /Taro\.navigateTo\s*\(/u)
  assert.match(taroSource, /Taro\.navigateBack\s*\(/u)
  assert.match(read('taro', 'src/pages/index/index.tsx'), /<Navigator\b/u)
  assertSyntheticSource(taroSource)

  const uniSource = sourceTree('uni-app', ['.ts', '.vue'])
  for (const component of ['input', 'button', 'switch', 'checkbox', 'radio']) {
    assert.match(uniSource, new RegExp(`<${component}\\b`, 'u'), component)
  }
  assert.match(uniSource, /v-for=/u)
  assert.match(uniSource, /uni\.navigateTo\s*\(/u)
  assert.match(uniSource, /uni\.navigateBack\s*\(/u)
  assert.match(read('uni-app', 'src/pages/index/index.vue'), /<navigator\b/u)
  assertSyntheticSource(uniSource)
})

for (const framework of ['taro', 'uni-app']) {
  const projectConfigPath = path.join(root(framework), 'project.config.json')
  const outputExists = fs.existsSync(projectConfigPath)
    && fs.existsSync(path.join(
      root(framework),
      JSON.parse(fs.readFileSync(projectConfigPath, 'utf8')).miniprogramRoot,
      'app.json',
    ))
  test(`${framework} compiled output satisfies the native five-page contract`, {
    skip: outputExists ? false : 'run the framework build first',
  }, () => {
    assertBuiltMiniProgram(framework)
    if (framework === 'uni-app') {
      const vendor = read('uni-app', 'dist/build/mp-weixin/common/vendor.js')
      assert.doesNotMatch(vendor, /wx\.preloadAssets|shadow-grey\.png/u)
    }
  })
}
