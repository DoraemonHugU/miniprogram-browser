#!/usr/bin/env node

/** 弹窗专项真机门禁：只验证 harness 已核验的 touristappid public Demo。 */

const { randomUUID } = require('node:crypto')
const { createHarness, isSuccessfulResult } = require('./lib/e2e-harness.cjs')

const route = '/pages/interaction/index'
const branches = [
  ['confirmModal', 'Status: Modal accepted'],
  ['cancelModal', 'Status: Modal dismissed'],
]

function main() {
  const h = createHarness({ tag: 'modal-e2e' })
  h.ensureEnv()
  const project = h.project
  const session = `modal-${randomUUID().slice(0, 12)}`
  const common = ['--session', session, '--project', project]
  const cleanup = h.installSessionCleanup([session])
  const runJson = (args) => {
    const result = h.runCli(args)
    const payload = h.parseJsonStdout(result)
    return { ok: isSuccessfulResult(result, payload), result, payload }
  }

  h.log(`project=${project}`)
  h.log(`session=${session}`)
  h.openSession(session)

  for (const [method, expectedStatus] of branches) {
    const label = `modal.${method}`
    const goto = runJson(['goto', route, ...common, '--await', `route:${route.slice(1)}`, '--timeout', '30000', '--json'])
    h.assertOk(goto.ok, `${label} goto failed`, goto.payload || goto.result)

    const ready = runJson(['get', 'text', '#interaction-status', ...common, '--json'])
    const readyText = String(ready.payload && ready.payload.text || '')
    h.assertOk(ready.ok && readyText === 'Status: Ready', `${label} did not start at Status: Ready`, ready.payload || ready.result)

    const click = runJson(['click', '#interaction-modal', ...common, '--json'])
    h.assertOk(click.ok, `${label} click failed`, click.payload || click.result)

    const native = runJson(['native', method, ...common, '--await', 'change', '--timeout', '3000', '--json'])
    const status = runJson(['get', 'text', '#interaction-status', ...common, '--json'])
    const actualStatus = String(status.payload && status.payload.text || '')
    if (!native.ok || !status.ok || actualStatus !== expectedStatus) {
      const screenshot = runJson(['screenshot', ...common, '--json'])
      if (screenshot.ok) h.log(`${label} failure screenshot=${screenshot.payload.path || '(default temp path)'}`)
      h.fail(`${label} callback was not verified`, { expectedStatus, actualStatus, native, status })
    }
    h.log(`${label} passed: ${actualStatus}`)
  }

  const cleanupResults = cleanup.run()
  h.assertOk(cleanupResults.every((result) => result.ok), 'session cleanup failed', cleanupResults)
  h.log(`PASS: modal confirm/cancel callbacks verified session=${session}`)
  process.exit(0)
}

if (require.main === module) main()
