/**
 * 真机 open 门禁：验证「能正确 open」——连上 automation 并能 path / snapshot。
 *
 * 退出码：
 *   0 = 通过
 *   1 = 失败（环境齐但 open/path/snapshot 未达预期）
 *   2 = 跳过（缺 CLI / 缺项目 / 显式 SKIP）
 *
 * 环境变量：
 *   WECHAT_DEVTOOLS_CLI              必填（或 --cli-path）
 *   MINIPROGRAM_BROWSER_GATE_PROJECT  项目根（默认识别 earlyRiser 路径）
 *   MINIPROGRAM_BROWSER_GATE_TIMEOUT  open 超时 ms，默认 120000
 *   MINIPROGRAM_BROWSER_GATE_SKIP=1   强制 skip
 *
 * 用法：
 *   npm run build && node scripts/real-open-gate.mjs
 *   npm run test:real-open-gate
 */

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '..')
const cliJs = path.join(repoRoot, 'dist', 'miniprogram-browser.js')

const DEFAULT_PROJECTS = [
  process.env.MINIPROGRAM_BROWSER_GATE_PROJECT,
  '/mnt/d/xuexi/projects/earlyRiser/apps/miniprogram',
  '/mnt/d/xuexi/projects/dali/xcx',
].filter(Boolean)

function log(msg) {
  process.stderr.write(`[real-open-gate] ${msg}\n`)
}

function resolveProject() {
  for (const candidate of DEFAULT_PROJECTS) {
    const resolved = path.resolve(candidate)
    if (fs.existsSync(path.join(resolved, 'project.config.json'))) {
      return resolved
    }
    // miniprogram 子目录
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
    // 显式设置了就信它：不存在 → 上层 skip；禁止静默回落到本机默认路径（避免测试/CI 误跑真机）
    return fromEnv
  }
  const fallback = '/mnt/f/Tools/wxwebtool/cli.js'
  if (fs.existsSync(fallback)) {
    return fallback
  }
  return ''
}

function runCli(args, env = {}, options = {}) {
  const openTimeout = Number(process.env.MINIPROGRAM_BROWSER_GATE_TIMEOUT || 120000)
  // 外层必须大于 CLI --timeout，否则 spawnSync 会先杀掉进程 → status=null、无 stdout
  const killMs = Number(options.killMs || openTimeout + 60000)
  const result = spawnSync(process.execPath, [cliJs, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env,
    },
    timeout: killMs,
    maxBuffer: 8 * 1024 * 1024,
  })
  return result
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
  // 从第一个 { 起尝试；失败再从最后一个 { 起
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
  log(`SKIP: ${reason}`)
  process.exit(2)
}

function fail(reason, detail) {
  log(`FAIL: ${reason}`)
  if (detail) {
    log(typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2).slice(0, 2000))
  }
  process.exit(1)
}

function pass(summary) {
  log(`PASS: ${summary}`)
  process.exit(0)
}

function main() {
  if (String(process.env.MINIPROGRAM_BROWSER_GATE_SKIP || '').trim() === '1') {
    skip('MINIPROGRAM_BROWSER_GATE_SKIP=1')
  }

  if (!fs.existsSync(cliJs)) {
    skip(`missing built CLI at ${cliJs}; run npm run build first`)
  }

  const devtoolsCli = resolveCliPath()
  if (!devtoolsCli) {
    skip('WECHAT_DEVTOOLS_CLI not set and no default cli.js found')
  }
  if (!fs.existsSync(devtoolsCli)) {
    skip(`DevTools CLI not found: ${devtoolsCli}`)
  }

  const project = resolveProject()
  if (!project) {
    skip('no gate project; set MINIPROGRAM_BROWSER_GATE_PROJECT to a miniprogram root with project.config.json')
  }

  const timeoutMs = String(process.env.MINIPROGRAM_BROWSER_GATE_TIMEOUT || '120000')
  const session = `gate-${Date.now().toString(36)}`
  const env = {
    WECHAT_DEVTOOLS_CLI: devtoolsCli,
  }

  log(`cli=${devtoolsCli}`)
  log(`project=${project}`)
  log(`session=${session}`)
  log(`timeout=${timeoutMs}ms`)

  // 1) open
  log('step: open')
  const openResult = runCli([
    'open',
    '--session', session,
    '--project', project,
    '--timeout', timeoutMs,
    '--json',
  ], env)

  const openPayload = parseJsonStdout(openResult)
  if (openResult.error && openResult.error.code === 'ETIMEDOUT') {
    fail('open gate process killed by outer timeout (increase MINIPROGRAM_BROWSER_GATE_TIMEOUT)', {
      error: String(openResult.error),
      status: openResult.status,
      signal: openResult.signal,
    })
  }
  if (openResult.status !== 0 || !openPayload || openPayload.ok === false) {
    fail('open did not succeed — DevTools automation may be unhealthy (login / cli server). Gate expects a healthy DevTools.', {
      status: openResult.status,
      signal: openResult.signal,
      stderr: String(openResult.stderr || '').slice(0, 400),
      payload: openPayload,
    })
  }

  const autoPort = openPayload.autoPort || (openPayload.automation && openPayload.automation.autoPort)
  const mode = openPayload.mode
  log(`open ok mode=${mode} autoPort=${autoPort} path=${openPayload.path || ''}`)

  if (!autoPort && !openPayload.session) {
    // 至少要有可观测连接信息
    fail('open payload missing autoPort/session observability fields', openPayload)
  }

  // 2) path
  log('step: path')
  const pathResult = runCli([
    'path',
    '--session', session,
    '--project', project,
    '--json',
  ], env)
  const pathPayload = parseJsonStdout(pathResult)
  if (pathResult.status !== 0) {
    fail('path command failed after open', {
      status: pathResult.status,
      payload: pathPayload,
      stderr: String(pathResult.stderr || '').slice(0, 400),
    })
  }
  log(`path ok path=${pathPayload && (pathPayload.path || pathPayload.message) || ''}`)

  // 3) snapshot -i（非识图主路径）
  log('step: snapshot -i')
  const snapResult = runCli([
    'snapshot',
    '-i',
    '--session', session,
    '--project', project,
    '--json',
  ], env)
  const snapPayload = parseJsonStdout(snapResult)
  if (snapResult.status !== 0) {
    fail('snapshot -i failed after open', {
      status: snapResult.status,
      payload: snapPayload,
      stderr: String(snapResult.stderr || '').slice(0, 400),
    })
  }

  const hasTree = Boolean(
    snapPayload
    && (
      (Array.isArray(snapPayload.records) && snapPayload.records.length >= 0)
      || snapPayload.lines
      || snapPayload.tree
      || snapPayload.ok !== false
    ),
  )
  if (!hasTree && snapPayload && snapPayload.ok === false) {
    fail('snapshot payload indicates failure', snapPayload)
  }
  log('snapshot ok')

  // 4) 可选：不强制 close，避免误关用户正在用的 DevTools；仅清 gate session 记录
  log('step: session kill (unbind gate session)')
  runCli([
    'session', 'kill', session,
    '--project', project,
    '--json',
  ], env)

  pass(`open→path→snapshot session=${session} mode=${mode || '-'} autoPort=${autoPort || '-'}`)
}

main()
