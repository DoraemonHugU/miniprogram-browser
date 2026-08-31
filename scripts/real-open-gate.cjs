/**
 * 真机 open 门禁：验证「能正确 open」——连上 automation 并能 path / snapshot。
 * 更完整 L0：node scripts/l0-e2e.cjs / npm run test:l0-e2e
 * 退出码：0 通过 · 1 失败 · 2 跳过
 */
const { createHarness, isSuccessfulResult } = require('./lib/e2e-harness.cjs')
const { randomUUID } = require('node:crypto')

const h = createHarness({ tag: 'real-open-gate' })
h.ensureEnv()

const project = h.project
const session = `gate-${randomUUID().slice(0, 12)}`
const cleanup = h.installSessionCleanup([session])

h.log(`cli=${h.devtoolsCli}`)
h.log(`project=${project}`)
h.log(`session=${session}`)
h.log(`timeout=${h.openTimeout}ms`)

h.log('step: open')
const openPayload = h.openSession(session)
const autoPort = openPayload.autoPort
const mode = openPayload.mode
h.log(`open ok mode=${mode} autoPort=${autoPort} path=${openPayload.path || ''}`)
h.assertOk(autoPort && openPayload.session, 'open missing observability fields', openPayload)

h.log('step: path')
const pathResult = h.runCli(['path', '--session', session, '--project', project, '--json'])
const pathPayload = h.parseJsonStdout(pathResult)
h.assertOk(isSuccessfulResult(pathResult, pathPayload) && String(pathPayload.path || '').startsWith('pages/'), 'path failed', { status: pathResult.status, payload: pathPayload })
h.log(`path ok path=${(pathPayload && (pathPayload.path || pathPayload.message)) || ''}`)

h.log('step: snapshot')
const snapResult = h.runCli(['snapshot', '--session', session, '--project', project, '--json'])
const snapPayload = h.parseJsonStdout(snapResult)
h.assertOk(isSuccessfulResult(snapResult, snapPayload) && Number(snapPayload.count) > 0, 'snapshot failed or empty', { status: snapResult.status, payload: snapPayload })
h.log('snapshot ok')

h.log('step: session kill (unbind gate session)')
const cleanupResults = cleanup.run()
h.assertOk(cleanupResults.every((result) => result.ok), 'session cleanup failed', cleanupResults)

h.log(`PASS: open→path→snapshot session=${session} mode=${mode || '-'} autoPort=${autoPort || '-'}`)
process.exit(0)
