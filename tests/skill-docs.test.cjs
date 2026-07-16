const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('path')
const { spawnSync } = require('node:child_process')

const repoRoot = path.resolve(__dirname, '..')
const cliPath = path.join(repoRoot, 'dist/miniprogram-browser.js')
const skillPath = path.join(repoRoot, 'skills/miniprogram-browser/SKILL.md')
const { normalizeAwaitCondition } = require('../dist/lib/runtime.js')

// Commands exposed by the CLI (top-level tokens from cli-help.ts cases + aliases).
const CLI_COMMAND_TOKENS = [
  'open', 'connect', 'goto', 'snapshot', 'click', 'fill', 'get', 'app', 'doctor',
  'await', 'devtools', 'protocol', 'timeline', 'logs', 'exceptions', 'page-stack',
  'system-info', 'eval', 'native', 'call', 'wait', 'screenshot', 'session',
  'query', 'within', 'relaunch', 'path',
  // aliases
  'tap', 'input',
]

// Escape-hatch / user-facing commands that should be documented in SKILL.md.
// Aliases (tap/input) are intentionally referenced via their primary command.
const SHOULD_BE_DOCUMENTED = [
  'open', 'connect', 'goto', 'snapshot', 'click', 'fill', 'get', 'await',
  'app', 'doctor', 'devtools', 'protocol', 'timeline', 'logs', 'exceptions',
  'page-stack', 'system-info', 'eval', 'native', 'call', 'wait', 'screenshot',
  'session', 'query', 'within', 'relaunch', 'path',
]

// 已实现但不在 `--help` 文本里显式列出的真实 flag（help 隐藏项）。
// 文档引用它们时，一致性守卫不应误报为「CLI 不支持」。
const KNOWN_HIDDEN_FLAGS = new Set(['--trust-project', '-h'])
const DOCUMENTED_CONDITIONS = [
  'app-ready', 'stable', 'route:/pages/index/index', 'route-settled',
  'route-change', 'visible:.page-root',
]

function runCli(args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-home-')), WECHAT_DEVTOOLS_CLI: '' },
  })
}

// Build the union of every flag the CLI advertises (top-level help + per-command help).
function buildCliFlagUnion() {
  const flags = new Set()
  const collect = (text) => {
    for (const m of text.matchAll(/\-\-(?:[a-z][a-z-]*[a-z]|[a-z])\b/g)) flags.add(m[0])
    for (const m of text.matchAll(/\s(-[a-z])\b/g)) flags.add(m[1])
  }
  collect(runCli(['help']).stdout)
  for (const cmd of CLI_COMMAND_TOKENS) {
    const res = runCli(['help', cmd])
    if (res.status === 0) collect(res.stdout)
  }
  return flags
}

const cliFlagUnion = buildCliFlagUnion()

// Real top-level commands: `help <cmd>` exits 0 (aliases resolve to primary command help).
const cliCommands = new Set(
  CLI_COMMAND_TOKENS.filter((cmd) => runCli(['help', cmd]).status === 0),
)

// Every flag the CLI advertises must be reachable. exercise the parser with documented conditions.

const commandAllowlist = new Set(CLI_COMMAND_TOKENS)

test('SKILL.md does not advertise a command the CLI does not implement', () => {
  const text = fs.readFileSync(skillPath, 'utf8')
  const seen = new Set()
  // 只把「字面量 miniprogram-browser <token>」且 token 在已知命令集合中当作命令引用，
  // 避免把 frontmatter「description:」或散文里的 close/help/system 误判为命令。
  for (const m of text.matchAll(/miniprogram-browser\s+([a-z][a-z-]*)\b/g)) {
    const token = m[1]
    if (commandAllowlist.has(token)) seen.add(token)
  }
  const missing = [...seen].filter((cmd) => !cliCommands.has(cmd))
  assert.deepEqual(missing, [], `SKILL.md references commands not present in CLI: ${missing.join(', ')}`)
})

test('SKILL.md flags all exist in the CLI', () => {
  const text = fs.readFileSync(skillPath, 'utf8')
  const seen = new Set()
  for (const m of text.matchAll(/\-\-(?:[a-z][a-z-]*[a-z]|[a-z])\b/g)) seen.add(m[0])
  for (const m of text.matchAll(/\s(-[a-z])\b/g)) seen.add(m[1])
  const missing = [...seen].filter((flag) => !cliFlagUnion.has(flag) && !KNOWN_HIDDEN_FLAGS.has(flag))
  assert.deepEqual(missing, [], `SKILL.md references flags not advertised by CLI: ${missing.join(', ')}`)
})

test('SKILL.md await conditions parse through the real CLI condition parser', () => {
  for (const cond of DOCUMENTED_CONDITIONS) {
    assert.doesNotThrow(
      () => normalizeAwaitCondition(cond),
      `documented await condition should parse: ${cond}`,
    )
  }
  // Negative: a nonsense condition must actually be rejected, proving the parser validates.
  assert.throws(() => normalizeAwaitCondition('definitely-not-a-condition'))
})

test('user-facing CLI commands are documented in SKILL.md', () => {
  const text = fs.readFileSync(skillPath, 'utf8')
  const missing = SHOULD_BE_DOCUMENTED.filter((cmd) => !text.includes(cmd))
  assert.deepEqual(missing, [], `CLI commands missing from SKILL.md: ${missing.join(', ')}`)
})
