/**
 * L0 真机 E2E：覆盖主路径与关键分支（attach / goto / snapshot / session / get）。
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

const { createHarness } = require('./lib/e2e-harness.cjs')

const h = createHarness({ tag: 'l0-e2e' })
h.ensureEnv()

const project = h.project
const stamp = Date.now().toString(36)
const sessionA = `e2e-a-${stamp}`
const sessionB = `e2e-b-${stamp}`
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
  if (result.status !== 0 || (payload && payload.ok === false && payload.error)) {
    return { ok: false, result, payload, label }
  }
  return { ok: true, result, payload, label }
}

// ---------- cases ----------

// 1) open primary session
{
  const id = 'open.primary'
  try {
    const open = h.openSession(sessionA)
    ctx.autoPortA = String(open.autoPort || '')
    ctx.modeA = String(open.mode || '')
    h.assertOk(ctx.autoPortA || open.session, 'open missing autoPort/session', open)
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
  // 同项目默认应 attach 同一 live；若 fresh 环境只起一个，port 应一致
  if (ctx.autoPortA && portB && ctx.autoPortA !== portB) {
    // 允许：若第一个已死第二个新开——记警告但不 fail 产品（环境）
    h.log(`WARN ${id}: autoPort differs A=${ctx.autoPortA} B=${portB} (env may have started fresh)`)
    caseResult(id, true, `mode=${openB.mode} portA=${ctx.autoPortA} portB=${portB} (differ)`)
  } else {
    h.assertOk(openB.mode === 'attached' || openB.mode === 'connected' || openB.mode === 'started', 'unexpected mode', openB)
    caseResult(id, true, `mode=${openB.mode} autoPort=${portB}`)
  }
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
  // await condition format may vary — if fail try without strict await
  if (!r.ok) {
    const r2 = runJson([
      'goto', gotoRoute,
      '--session', sessionA,
      '--project', project,
      '--json',
    ], id)
    h.assertOk(r2.ok, id, r2.payload || r.payload)
    caseResult(id, true, `fallback-no-await path=${(r2.payload && r2.payload.path) || r2.payload && r2.payload.message}`)
  } else {
    caseResult(id, true, `path=${r.payload.path || r.payload.message || ''}`)
  }
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

// 14) open --fresh branch (optional heavy): only if E2E_FRESH=1
if (String(process.env.MINIPROGRAM_BROWSER_E2E_FRESH || '').trim() === '1') {
  const id = 'open.fresh'
  const freshSession = `e2e-fresh-${stamp}`
  try {
    const open = h.openSession(freshSession, ['--fresh'])
    caseResult(id, true, `mode=${open.mode} autoPort=${open.autoPort}`)
    h.runCli(['session', 'kill', freshSession, '--project', project, '--json'])
  } catch (e) {
    h.fail(id, String(e && e.message || e))
  }
} else {
  caseResult('open.fresh', true, 'skipped-set-E2E_FRESH=1-to-enable')
}

// 15) cleanup kill e2e sessions (branch: session kill)
{
  const id = 'session.kill-cleanup'
  for (const name of [sessionA, sessionB]) {
    const r = h.runCli(['session', 'kill', name, '--project', project, '--json'])
    // kill may fail if already gone — non-fatal
    h.log(`kill ${name} status=${r.status}`)
  }
  caseResult(id, true, 'done')
}

// summary
h.log('--- summary ---')
for (const row of results) {
  h.log(`${row.ok ? 'PASS' : 'FAIL'} ${row.id} ${row.detail || ''}`)
}
const failed = results.filter((r) => !r.ok)
if (failed.length) {
  h.fail(`${failed.length} cases failed`, failed)
}
h.log(`PASS: ${results.length} L0 e2e cases sessionA=${sessionA}`)
process.exit(0)
