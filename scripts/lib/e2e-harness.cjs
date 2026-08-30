/**
 * 真机 E2E 共享：跑 CLI、解析 JSON、环境解析、skip/fail。
 * 供 real-open-gate 与 l0-e2e 复用。
 */

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

// scripts/lib → repo root is ../..
const repoRoot = path.resolve(__dirname, '..', '..')
const cliJs = path.join(repoRoot, 'dist', 'miniprogram-browser.js')

function log(tag, msg) {
  process.stderr.write(`[${tag}] ${msg}\n`)
}

function resolveProject() {
  const candidate = String(process.env.MINIPROGRAM_BROWSER_GATE_PROJECT || '').trim()
  if (candidate) {
    const resolved = path.resolve(candidate)
    if (fs.existsSync(path.join(resolved, 'project.config.json'))) {
      return resolved
    }
    const nested = path.join(resolved, 'miniprogram')
    if (fs.existsSync(path.join(nested, 'project.config.json'))) {
      return nested
    }
  }
  return ''
}

function resolveCliPath() {
  const fromEnv = String(process.env.WECHAT_DEVTOOLS_CLI || '').trim()
  if (fromEnv) {
    return fromEnv
  }
  return ''
}

function createHarness(options = {}) {
  const tag = options.tag || 'e2e'
  const openTimeout = Number(process.env.MINIPROGRAM_BROWSER_GATE_TIMEOUT || options.openTimeout || 120000)
  const project = resolveProject()
  const devtoolsCli = resolveCliPath()

  function runCli(args, extraEnv = {}, runOpts = {}) {
    const killMs = Number(runOpts.killMs || openTimeout + 60000)
    return spawnSync(process.execPath, [cliJs, ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        WECHAT_DEVTOOLS_CLI: devtoolsCli,
        ...extraEnv,
      },
      timeout: killMs,
      maxBuffer: 8 * 1024 * 1024,
    })
  }

  function parseJsonStdout(result) {
    const text = String(result.stdout || '').trim()
    if (!text) {
      return null
    }
    const start = text.indexOf('{')
    if (start < 0) {
      return { _parseError: 'no-json', _raw: text.slice(0, 500) }
    }
    const candidates = [text.slice(start)]
    const last = text.lastIndexOf('{')
    if (last > start) {
      candidates.unshift(text.slice(last))
    }
    for (const body of candidates) {
      try {
        return JSON.parse(body)
      } catch (_) {}
    }
    return { _parseError: 'json-parse-failed', _raw: text.slice(0, 800) }
  }

  function skip(reason) {
    log(tag, `SKIP: ${reason}`)
    process.exit(2)
  }

  function fail(reason, detail) {
    log(tag, `FAIL: ${reason}`)
    if (detail !== undefined) {
      const s = typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2)
      log(tag, s.slice(0, 2500))
    }
    process.exit(1)
  }

  function assertOk(cond, reason, detail) {
    if (!cond) {
      fail(reason, detail)
    }
  }

  function ensureEnv() {
    if (String(process.env.MINIPROGRAM_BROWSER_GATE_SKIP || '').trim() === '1') {
      skip('MINIPROGRAM_BROWSER_GATE_SKIP=1')
    }
    if (!fs.existsSync(cliJs)) {
      skip(`missing built CLI at ${cliJs}; run npm run build first`)
    }
    if (!devtoolsCli) {
      skip('WECHAT_DEVTOOLS_CLI not set')
    }
    if (!fs.existsSync(devtoolsCli)) {
      skip(`DevTools CLI not found: ${devtoolsCli}`)
    }
    if (!project) {
      skip('no gate project; set MINIPROGRAM_BROWSER_GATE_PROJECT')
    }
  }

  function openSession(sessionName, openArgs = []) {
    log(tag, `open session=${sessionName} ${openArgs.join(' ')}`)
    const result = runCli([
      'open',
      '--session', sessionName,
      '--project', project,
      '--timeout', String(openTimeout),
      '--json',
      ...openArgs,
    ])
    if (result.error && result.error.code === 'ETIMEDOUT') {
      fail('CLI process killed by outer timeout', { error: String(result.error) })
    }
    const payload = parseJsonStdout(result)
    assertOk(
      result.status === 0 && payload && payload.ok !== false && !payload.error,
      'open failed',
      { status: result.status, payload },
    )
    return payload
  }

  return {
    tag,
    repoRoot,
    cliJs,
    project,
    devtoolsCli,
    openTimeout,
    log: (msg) => log(tag, msg),
    runCli,
    parseJsonStdout,
    skip,
    fail,
    assertOk,
    ensureEnv,
    openSession,
  }
}

module.exports = {
  repoRoot,
  cliJs,
  createHarness,
  resolveProject,
  resolveCliPath,
}
