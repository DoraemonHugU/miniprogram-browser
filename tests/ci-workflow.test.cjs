const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'ci.yml')
const workflow = fs.readFileSync(workflowPath, 'utf8')

test('CI runs core checks on macOS, Windows and Ubuntu with declared and current Node lines', () => {
  for (const runner of ['macos-latest', 'windows-latest', 'ubuntu-latest']) {
    assert.match(workflow, new RegExp(`- ${runner}`))
  }
  assert.match(workflow, /node:\s*\n\s*- 22\s*\n\s*- 24/u)
  assert.match(workflow, /npm run typecheck:strict/u)
  assert.match(workflow, /npm run test:node/u)
  assert.match(workflow, /npm run test:package-install/u)
})

test('CI uses official setup actions and keeps real DevTools gates outside hosted runners', () => {
  assert.match(workflow, /actions\/checkout@v7/u)
  assert.match(workflow, /actions\/setup-node@v7/u)
  assert.match(workflow, /actions\/setup-python@v7/u)
  assert.doesNotMatch(workflow, /test:real-open-gate|test:l0-e2e/u)
})
