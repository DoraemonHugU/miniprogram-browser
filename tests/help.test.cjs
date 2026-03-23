const test = require('node:test')
const assert = require('node:assert/strict')

const {
  buildHelpText,
  buildCommandHelpText,
  getVersionText,
  parseArgs,
  parseFocusRefs,
  shouldAttemptVisualProbe,
  shouldEmitPreludeNotices,
  summarizeTimelinePayload,
  summarizeSnapshotPayload,
} = require('../scripts/miniprogram-browser.cjs')

test('buildHelpText groups commands by priority and purpose', () => {
  const help = buildHelpText()

  assert.match(help, /核心命令（优先使用）/)
  assert.match(help, /诊断与结构（推荐）/)
  assert.match(help, /逃逸点（高级）/)
  assert.match(help, /会话与连接/)
  assert.match(help, /app inspect/)
  assert.match(help, /eval <js>/)
})

test('buildHelpText mentions summary and full detail options', () => {
  const help = buildHelpText()

  assert.match(help, /--all/)
  assert.match(help, /--sections <a,b,c>/)
  assert.match(help, /help <command>/)
  assert.match(help, /-v, --version/)
})

test('getVersionText returns package version', () => {
  assert.equal(getVersionText(), require('../package.json').version)
})

test('buildCommandHelpText returns open command details', () => {
  const help = buildCommandHelpText('open')

  assert.match(help, /^open\/connect/m)
  assert.match(help, /--session <name>/)
  assert.match(help, /--project <path>/)
  assert.match(help, /WECHAT_DEVTOOLS_CLI/)
})

test('buildCommandHelpText returns screenshot mode details', () => {
  const help = buildCommandHelpText('screenshot')

  assert.match(help, /^screenshot/m)
  assert.match(help, /--mode <page\|visual\|annotate\|layout>/)
  assert.match(help, /--no-ref/)
  assert.match(help, /--focus <refs>/)
  assert.match(help, /--capsule/)
  assert.match(help, /-c\|--compact/)
  assert.match(help, /--raw/)
  assert.match(help, /layout/)
})

test('buildCommandHelpText returns snapshot layout option details', () => {
  const help = buildCommandHelpText('snapshot')

  assert.match(help, /^snapshot/m)
  assert.match(help, /--layout/)
})

test('parseFocusRefs normalizes comma separated focus refs', () => {
  assert.deepEqual(parseFocusRefs('@e1,@e2  @e3,@e1'), ['@e1', '@e2', '@e3'])
  assert.deepEqual(parseFocusRefs(undefined), [])
})

test('parseArgs keeps layout as boolean flag after session option', () => {
  const parsed = parseArgs(['snapshot', '-i', '--session', 'demo', '--layout'])
  assert.deepEqual(parsed.positional, ['snapshot'])
  assert.equal(parsed.options.session, 'demo')
  assert.equal(parsed.options.sessionProvided, true)
  assert.equal(parsed.options.layout, true)
})

test('parseArgs keeps layout as boolean flag before session option', () => {
  const parsed = parseArgs(['snapshot', '-i', '--layout', '--session', 'demo'])
  assert.deepEqual(parsed.positional, ['snapshot'])
  assert.equal(parsed.options.session, 'demo')
  assert.equal(parsed.options.sessionProvided, true)
  assert.equal(parsed.options.layout, true)
})

test('parseArgs keeps no-ref as boolean flag for screenshot', () => {
  const parsed = parseArgs(['screenshot', '--session', 'demo', '--mode', 'layout', '--no-ref'])
  assert.deepEqual(parsed.positional, ['screenshot'])
  assert.equal(parsed.options.session, 'demo')
  assert.equal(parsed.options.mode, 'layout')
  assert.equal(parsed.options.noRef, true)
})

test('summarizeTimelinePayload keeps only high-value route fields by default', () => {
  const result = summarizeTimelinePayload({
    events: [
      { ts: 1, kind: 'route', from: 'pages/a/index', to: 'pages/b/index', openType: 'navigateTo', message: 'navigateTo pages/a/index -> pages/b/index' },
      { ts: 2, kind: 'route', from: 'pages/b/index', to: 'pages/c/index', openType: 'navigateTo', message: 'navigateTo pages/b/index -> pages/c/index' },
      { ts: 3, kind: 'route', from: 'pages/c/index', to: 'pages/d/index', openType: 'navigateTo', message: 'navigateTo pages/c/index -> pages/d/index' },
      { ts: 4, kind: 'route', from: 'pages/d/index', to: 'pages/e/index', openType: 'navigateTo', message: 'navigateTo pages/d/index -> pages/e/index' },
      { ts: 5, kind: 'route', from: 'pages/e/index', to: 'pages/f/index', openType: 'navigateTo', message: 'navigateTo pages/e/index -> pages/f/index' },
      { ts: 6, kind: 'route', from: 'pages/f/index', to: 'pages/g/index', openType: 'navigateTo', message: 'navigateTo pages/f/index -> pages/g/index' },
      { ts: 7, kind: 'route', from: 'pages/g/index', to: 'pages/h/index', openType: 'navigateTo', message: 'navigateTo pages/g/index -> pages/h/index' },
    ],
  }, {})

  assert.deepEqual(result, {
    count: 7,
    events: [
      { kind: 'route', from: 'pages/c/index', to: 'pages/d/index', openType: 'navigateTo', message: 'navigateTo pages/c/index -> pages/d/index' },
      { kind: 'route', from: 'pages/d/index', to: 'pages/e/index', openType: 'navigateTo', message: 'navigateTo pages/d/index -> pages/e/index' },
      { kind: 'route', from: 'pages/e/index', to: 'pages/f/index', openType: 'navigateTo', message: 'navigateTo pages/e/index -> pages/f/index' },
      { kind: 'route', from: 'pages/f/index', to: 'pages/g/index', openType: 'navigateTo', message: 'navigateTo pages/f/index -> pages/g/index' },
      { kind: 'route', from: 'pages/g/index', to: 'pages/h/index', openType: 'navigateTo', message: 'navigateTo pages/g/index -> pages/h/index' },
    ],
    truncated: true,
  })
})

test('summarizeSnapshotPayload hides internal state unless --all', () => {
  const payload = {
    state: { route: 'pages/dashboard/index' },
    records: [{ ref: '@e1', kind: 'button', text: '保存', route: 'pages/dashboard/index', rectPct: { x: 10, y: 20, w: 30, h: 40 } }],
    lines: ['@e1 [button] 保存'],
  }

  assert.deepEqual(summarizeSnapshotPayload(payload, {}), {
    route: 'pages/dashboard/index',
    count: 1,
    records: [{ ref: '@e1', kind: 'button', text: '保存', route: 'pages/dashboard/index', rectPct: { x: 10, y: 20, w: 30, h: 40 } }],
    lines: ['@e1 [button] 保存'],
  })
  assert.equal(summarizeSnapshotPayload(payload, { all: true }).state.route, 'pages/dashboard/index')
})

test('shouldEmitPreludeNotices skips logs and exceptions', () => {
  assert.equal(shouldEmitPreludeNotices('path'), true)
  assert.equal(shouldEmitPreludeNotices('timeline'), true)
  assert.equal(shouldEmitPreludeNotices('logs'), false)
  assert.equal(shouldEmitPreludeNotices('exceptions'), false)
})

test('shouldAttemptVisualProbe only triggers when needed', () => {
  assert.equal(shouldAttemptVisualProbe({ pendingVisualAction: null, lastVisualProbe: null }, 'pages/a/index', null), true)
  assert.equal(shouldAttemptVisualProbe({ pendingVisualAction: null, lastVisualProbe: { route: 'pages/a/index' } }, 'pages/a/index', null), false)
  assert.equal(shouldAttemptVisualProbe({ pendingVisualAction: { route: 'pages/a/index' }, lastVisualProbe: { route: 'pages/a/index' } }, 'pages/a/index', null), true)
  assert.equal(shouldAttemptVisualProbe({ pendingVisualAction: { route: 'pages/a/index' }, lastVisualProbe: { route: 'pages/a/index' } }, 'pages/a/index', '@e1'), false)
})
