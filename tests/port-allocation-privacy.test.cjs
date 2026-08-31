const test = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const { assignPorts, selectUnprobedWslAutomationPort, isAutomationPortAvailable } = require('../dist/lib/session-store.js')

test('port allocation skips a candidate whose bind probe reports EADDRINUSE', async () => {
  const checked = []
  const result = await assignPorts({}, [], async (port) => {
    checked.push(port)
    if (checked.length === 1) throw Object.assign(new Error('synthetic occupied port'), { code: 'EADDRINUSE' })
    return true
  })
  assert.equal(checked.length, 2)
  assert.notEqual(Number(result.autoPort), checked[0])
  assert.equal(Number(result.autoPort), checked[1])
})

test('WSL port allocation does not treat a failed probe as proof of availability', async () => {
  const checked = []
  const result = await selectUnprobedWslAutomationPort(new Set(), async (port) => {
    checked.push(port)
    if (checked.length === 1) throw new Error('synthetic probe failure')
    return true
  })
  assert.equal(checked.length, 2)
  assert.equal(Number(result), checked[1])
})

test('native port allocation rejects a live listener even if a bind probe would succeed', async () => {
  let bindChecks = 0
  const available = await isAutomationPortAvailable(9515, {}, {
    runtime: 'darwin',
    listenerChecker: async () => false,
    localChecker: async () => { bindChecks += 1; return true },
  })
  assert.equal(available, false)
  assert.equal(bindChecks, 0)
})

test('an existing wildcard TCP listener is not an available automation port', async (t) => {
  const server = net.createServer((socket) => socket.destroy())
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '0.0.0.0', resolve)
  })
  t.after(() => server.close())
  assert.equal(await isAutomationPortAvailable(server.address().port), false)
})
