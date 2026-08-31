/**
 * L0 真机 E2E：仅使用 touristappid Demo，覆盖 session 复用、导航与真实交互。
 *
 * 退出码：0 pass · 1 fail · 2 skip
 *
 *   export WECHAT_DEVTOOLS_CLI=...
 *   export MINIPROGRAM_BROWSER_GATE_PROJECT=...
 *   npm run build && node scripts/l0-e2e.cjs
 *   npm run test:l0-e2e
 *
 * 环境：
 *   MINIPROGRAM_BROWSER_GATE_SKIP=1     强制 skip
 *   MINIPROGRAM_BROWSER_GATE_TIMEOUT    open 超时 ms
 *   MINIPROGRAM_BROWSER_E2E_GOTO_ROUTE  默认 /pages/controls/index
 */

const { createHarness, isSuccessfulResult } = require('./lib/e2e-harness.cjs')
const { randomUUID } = require('node:crypto')

const h = createHarness({ tag: 'l0-e2e' })
h.ensureEnv()

const project = h.project
const stamp = randomUUID().slice(0, 12)
const sessionA = `e2e-a-${stamp}`
const sessionB = `e2e-b-${stamp}`
const cleanup = h.installSessionCleanup([sessionA, sessionB])
const gotoRoute = String(process.env.MINIPROGRAM_BROWSER_E2E_GOTO_ROUTE || '/pages/controls/index').trim()
const homeRoute = '/pages/index/index'

const results = []
let ctx = {
  sessionA,
  sessionB,
  autoPortA: '',
  modeA: '',
}

function caseResult(id, ok, detail = '') {
  results.push({ id, ok, detail })
  h.log(`${ok ? 'ok' : 'FAIL'}  ${id}${detail ? ` — ${detail}` : ''}`)
  if (!ok) {
    h.fail(`case ${id}`, detail)
  }
}

function runJson(args, label) {
  const result = h.runCli(args)
  const payload = h.parseJsonStdout(result)
  if (!isSuccessfulResult(result, payload)) {
    return { ok: false, result, payload, label }
  }
  return { ok: true, result, payload, label }
}

function readText(selector, label) {
  const read = runJson(['get', 'text', selector, '--session', sessionA, '--project', project, '--json'], label)
  h.assertOk(read.ok, label, read.payload || read.result)
  return String((read.payload && read.payload.text) || '')
}

// ---------- cases ----------

// 1) open primary session
{
  const id = 'open.primary'
  try {
    const open = h.openSession(sessionA)
    ctx.autoPortA = String(open.autoPort || '')
    ctx.modeA = String(open.mode || '')
    h.assertOk(ctx.autoPortA && open.session, 'open missing autoPort/session', open)
    h.assertOk(open.path || open.appReady !== undefined, 'open missing path/appReady', open)
    caseResult(id, true, `mode=${ctx.modeA} autoPort=${ctx.autoPortA} path=${open.path || ''}`)
  } catch (e) {
    if (e && e.message) throw e
  }
}

// 2) path
{
  const id = 'path.current'
  const r = runJson(['path', '--session', sessionA, '--project', project, '--json'], id)
  h.assertOk(r.ok, id, r.payload || r.result)
  const p = (r.payload && (r.payload.path || r.payload.message)) || ''
  h.assertOk(String(p).includes('pages/'), 'path not a pages/* route', r.payload)
  caseResult(id, true, String(p))
}

// 3) get path
{
  const id = 'get.path'
  const r = runJson(['get', 'path', '--session', sessionA, '--project', project, '--json'], id)
  h.assertOk(r.ok, id, r.payload || { status: r.result.status, stdout: String(r.result.stdout || '').slice(0, 300) })
  caseResult(id, true, JSON.stringify(r.payload).slice(0, 120))
}

// 4) snapshot
{
  const id = 'snapshot.interactive'
  const r = runJson(['snapshot', '--session', sessionA, '--project', project, '--json'], id)
  h.assertOk(r.ok, id, r.payload || r.result)
  const count = Number(r.payload && (r.payload.count ?? (r.payload.records || []).length) || 0)
  h.assertOk(count > 0, 'snapshot has no records', r.payload)
  caseResult(id, true, `count=${count} route=${r.payload.route || ''}`)
}

// 5) second session attach same runtime (branch: multi-session share)
{
  const id = 'open.second-session-attach'
  const openB = h.openSession(sessionB)
  const portB = String(openB.autoPort || '')
  h.assertOk(portB && portB === ctx.autoPortA, 'second session did not reuse the same runtime', openB)
  h.assertOk(openB.mode === 'attached' || openB.mode === 'connected', 'second session started a new runtime', openB)
  caseResult(id, true, `mode=${openB.mode} autoPort=${portB}`)
}

// 6) session list contains both
{
  const id = 'session.list-contains'
  const r = runJson(['session', 'list', '--project', project, '--json'], id)
  h.assertOk(r.ok, id, r.payload)
  const names = (r.payload.sessions || []).map((s) => s.name)
  h.assertOk(names.includes(sessionA), `missing ${sessionA}`, names)
  h.assertOk(names.includes(sessionB), `missing ${sessionB}`, names)
  caseResult(id, true, `n=${names.length}`)
}

// 7) goto target page (branch: navigation)
{
  const id = 'goto.tools'
  const r = runJson([
    'goto', gotoRoute,
    '--session', sessionA,
    '--project', project,
    '--await', `route:${gotoRoute.replace(/^\//, '')}`,
    '--timeout', '30000',
    '--json',
  ], id)
  h.assertOk(r.ok, id, r.payload || r.result)
  caseResult(id, true, `path=${r.payload.path || r.payload.message || ''}`)
}

// 8) path after goto
{
  const id = 'path.after-goto'
  const r = runJson(['path', '--session', sessionA, '--project', project, '--json'], id)
  h.assertOk(r.ok, id, r.payload)
  const p = String((r.payload && (r.payload.path || r.payload.message)) || '')
  const expect = gotoRoute.replace(/^\//, '')
  h.assertOk(p.includes(expect), `expected ${expect}, got ${p}`, r.payload)
  caseResult(id, true, p)
}

// 9) snapshot on target page
{
  const id = 'snapshot.after-goto'
  const r = runJson(['snapshot', '--session', sessionA, '--project', project, '--no-map', '--json'], id)
  h.assertOk(r.ok, id, r.payload)
  const count = Number(r.payload && (r.payload.count ?? (r.payload.records || []).length) || 0)
  h.assertOk(count > 0, 'empty snapshot after goto', r.payload)
  caseResult(id, true, `count=${count} route=${r.payload.route || ''}`)
}

// 10) goto home again (branch: second navigation)
{
  const id = 'goto.home'
  const r = runJson([
    'goto', homeRoute,
    '--session', sessionA,
    '--project', project,
    '--json',
  ], id)
  h.assertOk(r.ok, id, r.payload)
  const pathResult = runJson(['path', '--session', sessionA, '--project', project, '--json'], 'path.home')
  h.assertOk(pathResult.ok, 'path after home goto', pathResult.payload)
  const p = String(pathResult.payload.path || pathResult.payload.message || '')
  h.assertOk(p.includes('pages/index/index'), `unexpected home path ${p}`, pathResult.payload)
  caseResult(id, true, p)
}

// 11) click by ref: require a real actionable node and hard click success
{
  const id = 'click.first-actionable'
  const snap = runJson(['snapshot', '--session', sessionA, '--project', project, '--json'], id)
  h.assertOk(snap.ok, 'snapshot before click', snap.payload)
  const records = (snap.payload && snap.payload.records) || []
  const target = records.find((x) => x && /^(navigator|link)$/iu.test(String(x.kind || '')))
    || records.find((x) => x && /button/iu.test(String(x.kind || '')))
  h.assertOk(target && target.ref, 'snapshot has no actionable navigator/button ref', snap.payload)
  const clickArgs = [
    'click', target.ref,
    '--session', sessionA,
    '--project', project,
    '--json',
  ]
  if (/^(navigator|link)$/iu.test(String(target.kind || ''))) {
    clickArgs.push('--await', 'route-change', '--timeout', '30000')
  }
  const r = runJson(clickArgs, id)
  h.assertOk(r.ok, `click ${target.ref} failed`, r.payload || r.result)
  caseResult(id, true, `clicked ${target.ref} kind=${target.kind}`)
}

// 12) logs command does not crash (branch: L1 soft)
{
  const id = 'logs.list'
  const r = runJson(['logs', '--session', sessionA, '--project', project, '--limit', '5', '--json'], id)
  h.assertOk(r.result.status === 0 || r.ok, id, { status: r.result.status, payload: r.payload })
  caseResult(id, true, 'ok')
}

// 13) page-stack
{
  const id = 'page-stack'
  const r = runJson(['page-stack', '--session', sessionA, '--project', project, '--json'], id)
  h.assertOk(r.result.status === 0 || r.ok, id, r.payload)
  caseResult(id, true, 'ok')
}

// 14) complex public Interaction journey: real touch, scroll, transient state and back.
{
  const id = 'interaction.goto'
  const route = '/pages/interaction/index'
  const r = runJson([
    'goto', route,
    '--session', sessionA,
    '--project', project,
    '--await', `route:${route.slice(1)}`,
    '--timeout', '30000',
    '--json',
  ], id)
  h.assertOk(r.ok, id, r.payload || r.result)
  caseResult(id, true, String(r.payload.path || r.payload.message || ''))
}

{
  const id = 'interaction.swipe-view'
  const r = runJson([
    'swipe', '#interaction-swipe-target', 'left', '120',
    '--session', sessionA,
    '--project', project,
    '--await', 'change',
    '--timeout', '5000',
    '--json',
  ], id)
  h.assertOk(r.ok, id, r.payload || r.result)
  const status = readText('#interaction-swipe-status', `${id}.status`)
  h.assertOk(/Swipe:\s*left/iu.test(status), `unexpected ordinary swipe status: ${status}`)
  caseResult(id, true, status)
}

{
  const id = 'interaction.swipe-view-right'
  const r = runJson([
    'swipe', '#interaction-swipe-target', 'right', '120',
    '--session', sessionA,
    '--project', project,
    '--await', 'change',
    '--timeout', '5000',
    '--json',
  ], id)
  h.assertOk(r.ok, id, r.payload || r.result)
  const status = readText('#interaction-swipe-status', `${id}.status`)
  h.assertOk(/Swipe:\s*right/iu.test(status), `unexpected ordinary swipe status: ${status}`)
  caseResult(id, true, status)
}

{
  const id = 'interaction.swipe-native'
  h.assertOk(/Swiper index:\s*0\b/iu.test(readText('#interaction-swiper-status', `${id}.before`)), 'swiper did not start at index 0')
  const r = runJson([
    'swipe', '#interaction-swiper', 'left', '180',
    '--session', sessionA,
    '--project', project,
    '--await', 'change',
    '--timeout', '5000',
    '--json',
  ], id)
  h.assertOk(r.ok, id, r.payload || r.result)
  const status = readText('#interaction-swiper-status', `${id}.status`)
  h.assertOk(/Swiper index:\s*1\b/iu.test(status), `unexpected swiper status: ${status}`)
  caseResult(id, true, status)
}

{
  const id = 'interaction.longpress'
  const r = runJson([
    'longpress', '#interaction-longpress',
    '--session', sessionA,
    '--project', project,
    '--await', 'change',
    '--timeout', '5000',
    '--json',
  ], id)
  h.assertOk(r.ok, id, r.payload || r.result)
  const status = readText('#interaction-status', `${id}.status`)
  h.assertOk(/Long press received/iu.test(status), `unexpected longpress status: ${status}`)
  caseResult(id, true, status)
}

{
  const id = 'interaction.transient'
  const r = runJson([
    'click', '#interaction-transient',
    '--follow',
    '--session', sessionA,
    '--project', project,
    '--await', 'change',
    '--timeout', '5000',
    '--json',
  ], id)
  h.assertOk(r.ok, id, r.payload || r.result)
  const status = ((r.payload.followup && r.payload.followup.records) || []).map((record) => record.text || '').join('\n')
  h.assertOk(/Transient visible/iu.test(status), `transient state was not captured: ${status}`)
  caseResult(id, true, 'Transient visible in action follow-up snapshot')
}

{
  const id = 'interaction.scroll-container'
  const r = runJson([
    'scroll', '#interaction-scroll', 'down', '120',
    '--session', sessionA,
    '--project', project,
    '--await', 'change',
    '--timeout', '5000',
    '--json',
  ], id)
  h.assertOk(r.ok, id, r.payload || r.result)
  const status = readText('#interaction-scroll-status', `${id}.status`)
  const top = Number((status.match(/(\d+)/u) || [])[1] || 0)
  h.assertOk(top > 0, `container did not scroll: ${status}`)
  caseResult(id, true, status)
}

{
  const id = 'interaction.scroll-page'
  const r = runJson([
    'scroll', 'down', '600',
    '--session', sessionA,
    '--project', project,
    '--await', 'change',
    '--timeout', '5000',
    '--json',
  ], id)
  h.assertOk(r.ok, id, r.payload || r.result)
  const status = readText('#interaction-page-scroll-status', `${id}.status`)
  const top = Number((status.match(/(\d+)/u) || [])[1] || 0)
  h.assertOk(top > 0, `page did not scroll: ${status}`)
  caseResult(id, true, status)
}

{
  const id = 'navigation.back'
  const navigationRoute = '/pages/navigation/index'
  const detailRoute = 'pages/detail/index'
  const gotoNavigation = runJson([
    'goto', navigationRoute,
    '--session', sessionA,
    '--project', project,
    '--await', `route:${navigationRoute.slice(1)}`,
    '--timeout', '30000',
    '--json',
  ], `${id}.goto`)
  h.assertOk(gotoNavigation.ok, `${id}.goto`, gotoNavigation.payload || gotoNavigation.result)
  const openDetail = runJson([
    'click', '#navigation-detail',
    '--session', sessionA,
    '--project', project,
    '--await', `route:${detailRoute}`,
    '--timeout', '10000',
    '--json',
  ], `${id}.open-detail`)
  h.assertOk(openDetail.ok, `${id}.open-detail`, openDetail.payload || openDetail.result)
  const back = runJson([
    'back',
    '--session', sessionA,
    '--project', project,
    '--await', `route:${navigationRoute.slice(1)}`,
    '--timeout', '10000',
    '--json',
  ], id)
  h.assertOk(back.ok, id, back.payload || back.result)
  const currentPath = runJson(['path', '--session', sessionA, '--project', project, '--json'], `${id}.path`)
  h.assertOk(currentPath.ok, `${id}.path`, currentPath.payload || currentPath.result)
  const path = String(currentPath.payload.path || currentPath.payload.message || '')
  h.assertOk(path.includes('pages/navigation/index'), `back returned to unexpected route: ${path}`)
  caseResult(id, true, path)
}

// 15) open --fresh branch (optional heavy): only if E2E_FRESH=1
if (String(process.env.MINIPROGRAM_BROWSER_E2E_FRESH || '').trim() === '1') {
  const id = 'open.fresh'
  const freshSession = `e2e-fresh-${stamp}`
  cleanup.add(freshSession)
  try {
    const open = h.openSession(freshSession, ['--fresh'])
    caseResult(id, true, `mode=${open.mode} autoPort=${open.autoPort}`)
  } catch (e) {
    h.fail(id, String(e && e.message || e))
  }
} else {
  results.push({ id: 'open.fresh', skipped: true, detail: 'set MINIPROGRAM_BROWSER_E2E_FRESH=1 to enable' })
}

// 16) cleanup kill e2e sessions (branch: session kill)
{
  const id = 'session.kill-cleanup'
  const cleanupResults = cleanup.run()
  h.assertOk(cleanupResults.every((result) => result.ok), id, cleanupResults)
  caseResult(id, true, 'done')
}

// summary
h.log('--- summary ---')
for (const row of results) {
  h.log(`${row.skipped ? 'SKIP' : row.ok ? 'PASS' : 'FAIL'} ${row.id} ${row.detail || ''}`)
}
const failed = results.filter((r) => !r.ok && !r.skipped)
if (failed.length) {
  h.fail(`${failed.length} cases failed`, failed)
}
h.log(`PASS: ${results.filter((r) => r.ok).length} L0 e2e cases; ${results.filter((r) => r.skipped).length} skipped; sessionA=${sessionA}`)
process.exit(0)
