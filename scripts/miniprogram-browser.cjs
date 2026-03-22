#!/usr/bin/env node

const path = require('node:path')
const packageJson = require('../package.json')

const {
  normalizeInspectSections,
  inspectProjectStructure,
  formatInspectLines,
} = require('./lib/app-inspect.cjs')

const {
  createVisualProbe,
  buildVisualDiffSummary,
  collectRecordRects,
} = require('./lib/visual-change.cjs')

const {
  assertBindingConsistency,
  assertProjectPath,
  acquireSessionLock,
  createDefaultConfig,
  ensureSessionPorts,
  listSessionStates,
  loadOtherSessionConfigs,
  mergeConfigOverrides,
  loadSessionState,
  saveSessionState,
  clearSessionState,
  releaseSessionLock,
  validateSessionPortConflicts,
} = require('./lib/session-store.cjs')

const {
  captureScreenshotToPath,
  sleep,
  shutdownMiniProgram,
  withMiniProgram,
  getCurrentPage,
  getSystemInfo,
  getRuntimeAppConfig,
  getPageStack,
  callWxMethod,
  callPageMethod,
  evaluateInMiniProgram,
  callNativeMethod,
  getElementAttribute,
  getElementProperty,
  getElementRect,
  syncRouteTimelineEvents,
  getStoredRouteTimeline,
  clearStoredRouteTimeline,
  formatRouteTimelineLine,
  getStoredRuntimeEvents,
  clearStoredRuntimeEvents,
  formatRuntimeEventLines,
  formatConsoleEventLine,
  formatExceptionEventLine,
  buildNativeDiagnostic,
  buildClickNotices,
  resolveTarget,
  snapshotInteractive,
  queryRecords,
  isRefToken,
} = require('./lib/runtime.cjs')

const {
  captureAnnotatedScreenshot,
  overlayFocusScreenshot,
  captureVisualScreenshot,
} = require('./lib/visual.cjs')

function buildHelpText() {
  return `miniprogram-browser - 微信小程序 agent-browser 风格 CLI

用法:
  miniprogram-browser <command> [args] [options]
  miniprogram-browser help <command>
  miniprogram-browser <command> --help
  miniprogram-browser -v | --version

核心命令（优先使用）:
  open                         绑定/连接一个小程序项目 session
  goto <route>                 重启到指定路由
  snapshot [-i]                生成 @e refs
  click <target>               点击 ref 或 selector
  fill <target> <text>         输入文本
  get <what> [target]          读取 text/value/count/data/path/attr/prop/rect

诊断与结构（推荐）:
  app inspect                  输出应用结构摘要
  timeline [clear]             查看或清空路由变化时间线
  logs [clear]                 查看或清空 console 输出
  exceptions [clear]           查看或清空异常输出
  page-stack                   读取当前页面栈
  system-info                  读取当前设备/systemInfo

逃逸点（高级）:
  query <mode> <value>         按 selector/text/business 查询
  within <ref> <command> ...   在 ref 作用域内继续执行命令
  eval <js>                    在小程序运行时执行 JavaScript
  native <method> [...args]    调用 native 原生控制能力
  call wx <method> [...args]   调用 wx 方法
  call page <method> [...args] 调用当前页方法

会话与连接:
  open                         绑定/连接一个小程序项目 session
  connect                      open 的别名
  session list                 列出已绑定的 session
  close                        关闭该 session 对应 DevTools 实例并解绑
  path                         输出当前页面路径
  relaunch <route>             重启到指定路由
  wait <target|ms>             等待 ref、selector 或固定毫秒
  screenshot [path]            截图并输出文件路径
  help                         输出帮助

兼容别名:
  tap                          click 的别名
  input                        fill 的别名

选项:
  --session <name>             session 名称；open/connect 首次绑定必须显式传
  --json                       以 JSON 输出
  --project <path>             小程序项目根目录；首次绑定必填
  --cli-path <path>            DevTools CLI 路径
  --auto-port <port>           自动化 ws 端口；不传则自动分配
  --devtools-port <port>       DevTools HTTP 端口
  --mode <page|visual|annotate> 截图模式，默认 page
  --wait <ms>                  等待时间或截图超时，截图默认 30000ms
  --limit <n>                  logs/exceptions 默认输出条数
  --sections <a,b,c>           app inspect 指定输出分区
  --all                        app inspect 输出全部分区
  --stdin                      从标准输入读取 eval 脚本
  -v, --version                输出当前 CLI 版本号
  -c, --compact                snapshot 时折叠空容器
  -d, --depth <n>              snapshot 时限制输出深度
`
}

function getVersionText() {
  return String(packageJson.version || '')
}

function buildCommandHelpText(command) {
  const normalized = String(command || '').trim()
  switch (normalized) {
    case 'open':
    case 'connect':
      return `open/connect

用法:
  miniprogram-browser open --session <name> --project <path> [options]

作用:
  绑定或连接一个微信小程序项目实例。

关键点:
  - 首次绑定必须显式传 --session 和 --project
  - fresh session 下 devtoolsPort/autoPort 可自动分配
  - 已有 live DevTools 实例时，不会静默改 HTTP 端口
  - 非标准安装路径 / WSL 场景下，可通过 WECHAT_DEVTOOLS_CLI 指定 CLI 路径

常用选项:
  --session <name>
  --project <path>
  --devtools-port <port>
  --auto-port <port>
  --cli-path <path>

示例:
  miniprogram-browser open --session demo --project /path/to/miniprogram-root
`
    case 'goto':
    case 'relaunch':
      return `goto/relaunch

用法:
  miniprogram-browser goto <route> --session <name> [--wait <ms>]

作用:
  重启到指定路由，并等待页面稳定。
`
    case 'snapshot':
      return `snapshot

用法:
  miniprogram-browser snapshot -i --session <name> [-c] [-d <n>] [--json] [--all]

作用:
  生成当前页面的语义 refs（@eN）。

常用选项:
  -i               生成交互 ref
  -c, --compact    折叠空容器，减少噪音
  -d, --depth <n>  限制层级，先看总览时使用
  --json           输出摘要化结构
  --all            输出完整细节
`
    case 'click':
    case 'tap':
      return `click/tap

用法:
  miniprogram-browser click <target> --session <name> [--wait <ms>]

作用:
  点击 ref 或 selector，并在同页未跳转时给出必要提示。
`
    case 'fill':
    case 'input':
      return `fill/input

用法:
  miniprogram-browser fill <target> <text> --session <name>

作用:
  向 ref 或 selector 输入文本。
`
    case 'get':
      return `get

用法:
  miniprogram-browser get <what> [target] [detail] --session <name>

支持:
  text | value | count | data | path | attr | prop | rect

示例:
  miniprogram-browser get text @e1 --session demo
  miniprogram-browser get attr @e1 class --session demo
`
    case 'app':
      return `app inspect

用法:
  miniprogram-browser app inspect --session <name> [--sections a,b,c] [--all]

作用:
  输出应用结构摘要；默认给核心摘要，--all 才展开完整分区。
`
    case 'timeline':
      return `timeline

用法:
  miniprogram-browser timeline --session <name> [--json] [--all]
  miniprogram-browser timeline clear --session <name>

作用:
  查看或清空路由变化时间线。
`
    case 'logs':
    case 'exceptions':
      return `${normalized}

用法:
  miniprogram-browser ${normalized} --session <name> [--limit <n>] [--json]
  miniprogram-browser ${normalized} clear --session <name>

作用:
  查看或清空当前 session 捕获到的运行时输出。
`
    case 'page-stack':
    case 'system-info':
    case 'path':
      return `${normalized}

用法:
  miniprogram-browser ${normalized} --session <name> [--json]
`
    case 'query':
      return `query

用法:
  miniprogram-browser query <mode> <value> --session <name>

支持:
  selector | text | business
`
    case 'within':
      return `within

用法:
  miniprogram-browser within <ref> <command> ... --session <name>

作用:
  在 ref 作用域内继续执行子命令。
`
    case 'eval':
      return `eval

用法:
  miniprogram-browser eval <js> --session <name>
  miniprogram-browser eval --stdin --session <name>

作用:
  在小程序 AppService 运行时执行 JavaScript。
`
    case 'native':
      return `native

用法:
  miniprogram-browser native <method> [...args] --session <name>

作用:
  调用开发者工具暴露的原生控制能力，例如 confirmModal / cancelModal / navigateLeft。
`
    case 'call':
      return `call

用法:
  miniprogram-browser call wx <method> [...args] --session <name>
  miniprogram-browser call page <method> [...args] --session <name>
`
    case 'wait':
      return `wait

用法:
  miniprogram-browser wait <target|ms> --session <name>

作用:
  等待 ref、selector 或固定毫秒。
`
    case 'screenshot':
      return `screenshot

用法:
  miniprogram-browser screenshot [path] --session <name> [--mode <page|visual|annotate>] [--focus <refs>] [--wait <ms>] [--json]

模式:
  page      官方页面截图
  visual    页面截图 + 胶囊视觉合成
  annotate  页面截图 + @eNN 标注叠加

说明:
  - 默认模式是 page
  - --focus 支持 @e1,@e2 这类多个 ref，高亮时会自动换色
  - 不传路径时保存到默认截图目录
`
    case 'session':
      return `session

用法:
  miniprogram-browser session list [--json]

作用:
  查看当前已绑定的 session 列表。
`
    case 'close':
      return `close

用法:
  miniprogram-browser close --session <name>

作用:
  关闭该 session 对应的 DevTools 实例并解绑。
`
    case 'help':
      return `help

用法:
  miniprogram-browser help
  miniprogram-browser help <command>
  miniprogram-browser <command> --help
`
    default:
      return ''
  }
}

function summarizeTimelinePayload(payload, options) {
  if (options.all) {
    return payload
  }

  const events = Array.isArray(payload.events) ? payload.events : []
  const latestEvents = events.slice(-5)
  return {
    count: events.length,
    events: latestEvents.map((event) => ({
      kind: event.kind,
      from: event.from,
      to: event.to,
      openType: event.openType,
      message: event.message,
    })),
    truncated: events.length > latestEvents.length,
  }
}

function summarizeSnapshotPayload(payload, options) {
  if (options.all) {
    return payload
  }

  const records = Array.isArray(payload.records) ? payload.records.map((record) => ({
    ref: record.ref,
    kind: record.kind,
    text: record.text,
    route: record.route,
  })) : []

  const summary = {
    route: payload.state && payload.state.route ? payload.state.route : null,
    count: records.length,
    records,
    lines: Array.isArray(payload.lines) ? payload.lines : [],
  }

  if (payload.visual) {
    summary.visual = payload.visual
  }

  return summary
}

function shouldEmitPreludeNotices(command) {
  return !['logs', 'exceptions'].includes(String(command || ''))
}

function shouldAttemptVisualProbe(state, route, scopeRef = null) {
  if (scopeRef) {
    return false
  }

  if (state.pendingVisualAction) {
    return true
  }

  if (!state.lastVisualProbe) {
    return true
  }

  return state.lastVisualProbe.route !== route
}

function markPendingVisualAction(state, action, route) {
  state.pendingVisualAction = {
    action,
    route,
    ts: Date.now(),
  }
}

async function captureVisualProbeForSnapshot(miniProgram, page, state, records, screenshotPath) {
  try {
    return await createVisualProbe({
      miniProgram,
      page,
      records,
      config: state.config,
      screenshotPath,
      cleanupScreenshot: Boolean(screenshotPath),
      captureScreenshot: async (instance, targetPath) => captureScreenshotToPath(instance, targetPath, 2500),
    })
  } catch (_) {
    return null
  }
}

function maybeBuildImplicitVisualChange(state, currentProbe) {
  const pending = state.pendingVisualAction
  const previous = state.lastVisualProbe
  if (!pending || !previous || !currentProbe) {
    state.lastVisualProbe = currentProbe || state.lastVisualProbe || null
    state.pendingVisualAction = null
    return null
  }

  let visual = null
  if (pending.route === currentProbe.route && previous.route === currentProbe.route) {
    visual = buildVisualDiffSummary(previous, currentProbe)
  }

  state.lastVisualProbe = currentProbe
  state.pendingVisualAction = null
  return visual
}

function printHelp() {
  console.log(buildHelpText())
}

function printCommandHelp(command) {
  const help = buildCommandHelpText(command)
  if (!help) {
    throw new Error(`Unknown help topic: ${command}`)
  }
  console.log(help)
}

async function readStdin() {
  if (process.stdin.isTTY) {
    return ''
  }

  let content = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) {
    content += chunk
  }
  return content
}

function parseArgs(argv) {
  const positional = []
  const options = {
    session: 'default',
    sessionProvided: false,
    json: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '-h') {
      options.help = true
      continue
    }
    if (token === '-v') {
      options.version = true
      continue
    }
    if (token === '-i') {
      options.interactive = true
      continue
    }

    if (token === '-c') {
      options.compact = true
      continue
    }

    if (token === '-d') {
      options.depth = argv[index + 1]
      index += 1
      continue
    }

    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }

    const key = token.slice(2)
    if (key === 'json') {
      options.json = true
      continue
    }

    if (key === 'help') {
      options.help = true
      continue
    }

    if (key === 'version') {
      options.version = true
      continue
    }

    if (key === 'compact') {
      options.compact = true
      continue
    }

    if (key === 'all') {
      options.all = true
      continue
    }

    if (key === 'stdin') {
      options.stdin = true
      continue
    }

    const value = argv[index + 1]
    const normalizedKey = key.replace(/-([a-z])/gu, (_, char) => char.toUpperCase())
    if (normalizedKey === 'focus' && options.focus) {
      options.focus = `${options.focus},${value}`
    } else {
      options[normalizedKey] = value
    }
    if (normalizedKey === 'session') {
      options.sessionProvided = true
    }
    index += 1
  }

  return { positional, options }
}

function buildExplicitOverrides(options) {
  return {
    projectPath: options.project,
    cliPath: options.cliPath,
    autoPort: options.autoPort,
    devtoolsPort: options.devtoolsPort,
  }
}

function emit(payload, options) {
  const notices = Array.isArray(options._notices) ? options._notices : []

  if (options.json) {
    const output = notices.length
      ? { ...payload, notices: [...(Array.isArray(payload.notices) ? payload.notices : []), ...notices] }
      : payload
    console.log(JSON.stringify(output, null, 2))
    return
  }

  if (notices.length) {
    process.stderr.write(`${notices.join('\n')}\n`)
  }

  if (Array.isArray(payload.lines)) {
    console.log(payload.lines.join('\n'))
    return
  }

  if (typeof payload.message === 'string') {
    console.log(payload.message)
    return
  }

  console.log(JSON.stringify(payload, null, 2))
}

function emitProgress(message, options) {
  if (options.json || !message) {
    return
  }
  process.stderr.write(`${message}\n`)
}

function parseFocusRefs(value) {
  if (!value) {
    return []
  }

  return [...new Set(
    String(value)
      .split(/[\s,]+/u)
      .map((item) => item.trim())
      .filter(Boolean),
  )]
}

async function resolveSession(options) {
  const baseConfig = createDefaultConfig()
  const state = await loadSessionState(options.session, baseConfig)
  const explicitOverrides = buildExplicitOverrides(options)
  assertBindingConsistency(state.config || {}, explicitOverrides)
  state.config = mergeConfigOverrides(state.config || baseConfig, explicitOverrides)
  delete state.config.interactiveSelectors

  if (explicitOverrides.devtoolsPort || explicitOverrides.autoPort) {
    const otherConfigs = await loadOtherSessionConfigs(state.config, state.name)
    validateSessionPortConflicts(state.config, otherConfigs)
  }

  await ensureSessionPorts(state)
  return state
}

async function handleOpen(state, options) {
  if (!options.sessionProvided) {
    throw new Error('首次 open/connect 必须显式传 --session <name>。')
  }
  assertProjectPath(state.config)
  const result = await withMiniProgram(state, async (miniProgram) => {
    const page = await getCurrentPage(miniProgram).catch(() => null)
    return {
      ok: true,
      path: page ? page.path : null,
      projectPath: state.config.projectPath,
      devtoolsPort: state.config.devtoolsPort,
      autoPort: state.config.autoPort,
      autoPortAssigned: Boolean(state.portResolution && state.portResolution.autoPortAssigned),
    }
  }, {
    preferEnable: true,
    onProgress(phase) {
      if (phase === 'enable') {
        emitProgress('正在启动/连接 DevTools 自动化...', options)
        return
      }
      if (phase === 'connect') {
        emitProgress('正在等待小程序实例就绪...', options)
      }
    },
  })

  await saveSessionState(state)
  emit({
    message: `已连接 path=${result.path || '(no page)'} project=${result.projectPath} devtoolsPort=${result.devtoolsPort} autoPort=${result.autoPort}${result.autoPortAssigned ? ' (auto)' : ''}`,
    path: result.path,
    projectPath: result.projectPath,
    devtoolsPort: result.devtoolsPort,
    autoPort: result.autoPort,
    autoPortAssigned: result.autoPortAssigned,
  }, options)
}

async function handleSessionList(options) {
  const baseConfig = createDefaultConfig()
  const sessions = await listSessionStates(baseConfig)

  if (options.json) {
    emit({ sessions }, options)
    return
  }

  if (!sessions.length) {
    emit({ message: '当前没有已保存的 session' }, options)
    return
  }

  emit({
    lines: sessions.map((item) => {
      const project = item.projectPath || '(unbound)'
      const route = item.route || '(no route)'
      return `${item.name} project=${project} devtoolsPort=${item.devtoolsPort || '-'} autoPort=${item.autoPort || '-'} route=${route}`
    }),
  }, options)
}

async function handlePath(state, options) {
  const pathValue = await withMiniProgram(state, async (miniProgram) => {
    const page = await getCurrentPage(miniProgram)
    state.route = page.path
    return page.path
  })

  await saveSessionState(state)
  emit({ message: pathValue, path: pathValue }, options)
}

async function handleRelaunch(state, route, options) {
  const waitMs = Number(options.wait || 1500)
  const pathValue = await withMiniProgram(state, async (miniProgram) => {
    await miniProgram.reLaunch(route)
    await sleep(waitMs)
    const page = await getCurrentPage(miniProgram)
    state.route = page.path
    return page.path
  })

  await saveSessionState(state)
  emit({ message: pathValue, path: pathValue }, options)
}

async function handleSnapshot(state, options, scopeRef = null) {
  const payload = await withMiniProgram(state, async (miniProgram) => {
    const page = await getCurrentPage(miniProgram)
    const result = await snapshotInteractive(page, state, scopeRef, {
      compact: Boolean(options.compact),
      depth: options.depth === undefined ? undefined : Number(options.depth),
    })
    Object.assign(state, result.state)

    let visual = null
    if (shouldAttemptVisualProbe(state, page.path, scopeRef)) {
      const visualProbePath = path.join(state.config.tempScreenshotDir, `visual-probe-${Date.now()}-${Math.random().toString(16).slice(2)}.png`)
      const currentProbe = await captureVisualProbeForSnapshot(miniProgram, page, state, result.records, visualProbePath)
      visual = maybeBuildImplicitVisualChange(state, currentProbe)
    }

    return {
      ...result,
      visual,
    }
  })

  await saveSessionState(state)
  emit(summarizeSnapshotPayload(payload, options), options)
}

async function handleQuery(state, mode, value, options, scopeRef = null) {
  const payload = await withMiniProgram(state, async (miniProgram) => {
    const page = await getCurrentPage(miniProgram)
    const result = await queryRecords(page, state, mode, value, scopeRef)
    Object.assign(state, result.state)
    return result
  })

  await saveSessionState(state)
  emit(payload, options)
}

async function handleTap(state, target, options, scopeRef = null) {
  const waitMs = Number(options.wait || 1200)
  const payload = await withMiniProgram(state, async (miniProgram) => {
    const page = await getCurrentPage(miniProgram)
    const pathBefore = page.path
    const element = await resolveTarget(page, state, target, scopeRef)
    await element.tap()
    await sleep(waitMs)
    const timelineResult = await syncRouteTimelineEvents(miniProgram, state)
    const currentPage = await getCurrentPage(miniProgram)
    state.route = currentPage.path
    return {
      message: `已点击 ${target}`,
      path: currentPage.path,
      notices: buildClickNotices({
        pathBefore,
        pathAfter: currentPage.path,
        routeEvents: timelineResult.events,
      }),
    }
  })

  markPendingVisualAction(state, 'click', payload.path)
  await saveSessionState(state)
  emit(payload, options)
}

async function handleInput(state, target, value, options, scopeRef = null) {
  const waitMs = Number(options.wait || 500)
  const payload = await withMiniProgram(state, async (miniProgram) => {
    const page = await getCurrentPage(miniProgram)
    const pathBefore = page.path
    const element = await resolveTarget(page, state, target, scopeRef)
    await element.input(value)
    await sleep(waitMs)
    return { message: `已输入 ${target}`, path: pathBefore }
  })

  markPendingVisualAction(state, 'fill', payload.path)
  await saveSessionState(state)
  emit(payload, options)
}

async function handleWait(state, target, options, scopeRef = null) {
  const timeoutMs = Number(options.wait || 10000)

  await withMiniProgram(state, async (miniProgram) => {
    const page = await getCurrentPage(miniProgram)
    if (/^\d+$/u.test(target)) {
      await sleep(Number(target))
      return
    }

    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      try {
        if (isRefToken(target)) {
          await resolveTarget(page, state, target, scopeRef)
          return
        }

        const scope = scopeRef ? await resolveTarget(page, state, scopeRef) : page
        const matches = await scope.$$(target)
        if (matches.length > 0) {
          return
        }
      } catch (_) {
      }

      await sleep(200)
    }

    throw new Error(`wait timeout: ${target}`)
  })

  await saveSessionState(state)
  emit({ message: `等待完成 ${target}` }, options)
}

async function handleGet(state, what, target, detail, options, scopeRef = null) {
  const payload = await withMiniProgram(state, async (miniProgram) => {
    const page = await getCurrentPage(miniProgram)

    switch (what) {
      case 'path':
        return { message: page.path, path: page.path }
      case 'data':
        return { data: target ? await page.data(target) : await page.data() }
      case 'count': {
        if (!target) {
          throw new Error('get count requires a selector or ref')
        }
        if (isRefToken(target)) {
          await resolveTarget(page, state, target, scopeRef)
          return { count: 1 }
        }
        const scope = scopeRef ? await resolveTarget(page, state, scopeRef) : page
        const matches = await scope.$$(target)
        return { count: matches.length }
      }
      case 'text': {
        const element = await resolveTarget(page, state, target, scopeRef)
        return { text: await element.text() }
      }
      case 'value': {
        const element = await resolveTarget(page, state, target, scopeRef)
        return { value: await element.value() }
      }
      case 'attr': {
        const element = await resolveTarget(page, state, target, scopeRef)
        return { value: await getElementAttribute(element, detail) }
      }
      case 'prop': {
        const element = await resolveTarget(page, state, target, scopeRef)
        return { value: await getElementProperty(element, detail) }
      }
      case 'rect': {
        const element = await resolveTarget(page, state, target, scopeRef)
        return { rect: await getElementRect(element) }
      }
      default:
        throw new Error(`Unknown get target: ${what}`)
    }
  })

  await saveSessionState(state)
  emit(payload, options)
}

async function handleEval(state, source, options) {
  const script = options.stdin ? await readStdin() : source
  const payload = await withMiniProgram(state, async (miniProgram) => {
    const result = await evaluateInMiniProgram(miniProgram, script)
    return {
      result,
      message: options.json ? undefined : JSON.stringify(result, null, 2),
    }
  })

  await saveSessionState(state)
  emit(payload, options)
}

async function handleNative(state, method, args, options) {
  const waitMs = Number(options.wait || 800)
  const payload = await withMiniProgram(state, async (miniProgram) => {
    const page = await getCurrentPage(miniProgram)
    const pathBefore = page.path
    const result = await callNativeMethod(miniProgram, method, args)
    if (waitMs > 0) {
      await sleep(waitMs)
    }
    const timelineResult = await syncRouteTimelineEvents(miniProgram, state)
    const currentPage = await getCurrentPage(miniProgram).catch(() => ({ path: pathBefore }))
    state.route = currentPage.path || pathBefore
    const diagnostic = buildNativeDiagnostic(method, result, {
      pathBefore,
      pathAfter: state.route,
      routeEvents: timelineResult.events,
    })
    if (!options.json && !diagnostic.error && !diagnostic.message) {
      diagnostic.message = JSON.stringify(result, null, 2)
    }
    return diagnostic
  })

  markPendingVisualAction(state, `native:${method}`, payload.path)
  await saveSessionState(state)
  emit(payload, options)
}

async function handleSystemInfo(state, options) {
  const payload = await withMiniProgram(state, async (miniProgram) => {
    const systemInfo = await getSystemInfo(miniProgram)
    return {
      systemInfo,
      message: options.json ? undefined : JSON.stringify(systemInfo, null, 2),
    }
  })

  await saveSessionState(state)
  emit(payload, options)
}

async function handlePageStack(state, options) {
  const payload = await withMiniProgram(state, async (miniProgram) => {
    const pages = await getPageStack(miniProgram)
    return {
      pages,
      lines: pages.map((item, index) => `${index + 1}. ${item.path}`),
    }
  })

  await saveSessionState(state)
  emit(payload, options)
}

function buildObservedEdges(routeEvents) {
  return (routeEvents || []).map((event) => ({
    from: event.from,
    to: event.to,
    method: event.openType,
  }))
}

async function handleAppInspect(state, options) {
  const sections = normalizeInspectSections(options)
  const payload = await withMiniProgram(state, async (miniProgram) => {
    await syncRouteTimelineEvents(miniProgram, state)
    const runtimeConfig = await getRuntimeAppConfig(miniProgram)
    const pageStack = await getPageStack(miniProgram)
    const current = pageStack.length > 0 ? pageStack[pageStack.length - 1].path : (state.route || null)
    const recentRoutes = getStoredRouteTimeline(state, { limit: 10 })
    const observedEdges = buildObservedEdges(state.routeEvents)
    const result = await inspectProjectStructure({
      projectPath: state.config.projectPath,
      runtimeConfig,
      current,
      pageStack,
      recentRoutes,
      observedEdges,
      sections,
    })

    return {
      ...result,
      lines: formatInspectLines(result),
    }
  })

  await saveSessionState(state)
  emit(payload, options)
}

async function handleTimeline(state, action, options) {
  if (action === 'clear') {
    clearStoredRouteTimeline(state)
    await saveSessionState(state)
    emit({ message: '已清空 timeline' }, options)
    return
  }

  const payload = await withMiniProgram(state, async (miniProgram) => {
    await syncRouteTimelineEvents(miniProgram, state)
    const events = getStoredRouteTimeline(state, { limit: options.limit })
    return {
      events,
      lines: events.map(formatRouteTimelineLine),
      message: events.length ? undefined : '当前没有 route timeline',
    }
  })

  await saveSessionState(state)
  emit(summarizeTimelinePayload(payload, options), options)
}

async function handleLogs(state, kind, action, options) {
  if (action === 'clear') {
    clearStoredRuntimeEvents(state, kind)
    await saveSessionState(state)
    emit({ message: kind === 'exception' ? '已清空 exceptions' : '已清空 logs' }, options)
    return
  }

  const waitMs = Number(options.wait || 0)
  if (waitMs > 0) {
    await withMiniProgram(state, async () => {
      await sleep(waitMs)
    })
    await saveSessionState(state)
  }

  const events = getStoredRuntimeEvents(state, kind, { limit: options.limit })
  const lines = formatRuntimeEventLines(
    events,
    kind === 'exception' ? formatExceptionEventLine : formatConsoleEventLine,
  )
  emit({
    events,
    lines,
    message: lines.length ? undefined : (kind === 'exception' ? '当前没有 exception' : '当前没有 console 输出'),
  }, options)
}

async function syncRouteTimelinePrelude(state, options, command) {
  if (!shouldEmitPreludeNotices(command)) {
    return
  }

  if (command === 'open' || command === 'connect' || command === 'close') {
    return
  }

  if (!state.config || !String(state.config.projectPath || '').trim()) {
    return
  }

  const payload = await withMiniProgram(state, async (miniProgram) => {
    return syncRouteTimelineEvents(miniProgram, state)
  })

  if (payload.events.length) {
    await saveSessionState(state)
  }

  if (payload.events.length) {
    options._notices = [
      `自上次命令后路由变化 ${payload.events.length} 次`,
      ...payload.events.map(formatRouteTimelineLine),
    ]
  }
}

async function handleCall(state, target, method, args, options) {
  if (!target || !method) {
    throw new Error('call requires target and method, e.g. call wx getSystemInfoSync')
  }

  const payload = await withMiniProgram(state, async (miniProgram) => {
    const page = target === 'page' ? await getCurrentPage(miniProgram) : null
    if (target === 'wx') {
      const result = await callWxMethod(miniProgram, method, args)
      return { result, path: state.route || '', message: options.json ? undefined : JSON.stringify(result, null, 2) }
    }

    if (target === 'page') {
      const result = await callPageMethod(page, method, args)
      return { result, path: page.path, message: options.json ? undefined : JSON.stringify(result, null, 2) }
    }

    throw new Error(`Unsupported call target: ${target}`)
  })

  if (target === 'wx' || target === 'page') {
    markPendingVisualAction(state, `call:${target}:${method}`, payload.path)
  }
  await saveSessionState(state)
  emit(payload, options)
}

async function handleScreenshot(state, outputPath, options) {
  const payload = await withMiniProgram(state, async (miniProgram) => {
    const mode = options.mode || 'page'
    const focusRefs = parseFocusRefs(options.focus)
    const timeoutMs = Number(options.wait || 30000)
    const name = outputPath
      ? path.isAbsolute(outputPath)
        ? outputPath
        : path.join(process.cwd(), outputPath)
      : path.join(state.config.tempScreenshotDir, `shot-${Date.now()}.png`)

    async function resolveRefs() {
      const page = await getCurrentPage(miniProgram)
      const snapshot = await snapshotInteractive(page, state, null, { compact: true })
      Object.assign(state, snapshot.state)
      return collectRecordRects(page, snapshot.records, await miniProgram.systemInfo())
    }

    if (mode === 'visual') {
      const result = await captureVisualScreenshot({
        miniProgram,
        targetPath: name,
        config: state.config,
        timeoutMs,
        pageCapture: async (targetPath, timeoutMs) => {
          return captureScreenshotToPath(miniProgram, targetPath, timeoutMs)
        },
      })

      let focusLegend
      let source = result.source
      if (focusRefs.length) {
        const focus = await overlayFocusScreenshot({
          targetPath: name,
          config: state.config,
          refs: await resolveRefs(),
          focusRefs,
        })
        focusLegend = focus.focusLegend
        source = `${source}+focus`
      }

      return {
        message: `截图已保存 ${result.path} mode=${result.mode} source=${source}`,
        path: result.path,
        mode: result.mode,
        source,
        focusLegend,
      }
    }

    if (mode === 'annotate') {
      const page = await getCurrentPage(miniProgram)
      await captureScreenshotToPath(miniProgram, name, timeoutMs)
      const snapshot = await snapshotInteractive(page, state, null, { compact: true })
      Object.assign(state, snapshot.state)
      const refs = await collectRecordRects(page, snapshot.records, await miniProgram.systemInfo())
      const result = await captureAnnotatedScreenshot({
        miniProgram,
        targetPath: name,
        config: state.config,
        refs,
        focusRefs,
        timeoutMs,
        pageCapture: async (targetPath) => targetPath,
      })

      return {
        message: `截图已保存 ${result.path} mode=${result.mode} source=${result.source}`,
        path: result.path,
        mode: result.mode,
        source: result.source,
        legend: result.legend,
        focusLegend: result.focusLegend,
      }
    }

    const screenshotPath = await captureScreenshotToPath(miniProgram, name, timeoutMs)
    let source = 'page'
    let focusLegend

    if (focusRefs.length) {
      const focus = await overlayFocusScreenshot({
        targetPath: screenshotPath,
        config: state.config,
        refs: await resolveRefs(),
        focusRefs,
      })
      focusLegend = focus.focusLegend
      source = 'page+focus'
    }

    return {
      message: `截图已保存 ${screenshotPath} mode=page source=${source}`,
      path: screenshotPath,
      mode: 'page',
      source,
      focusLegend,
    }
  })

  await saveSessionState(state)
  emit(payload, options)
}

async function handleClose(state, options) {
  await withMiniProgram(state, async (miniProgram) => {
    await shutdownMiniProgram(miniProgram)
  }).catch(() => {})
  await clearSessionState(state.name, state.config)
  emit({ message: `已关闭 session ${state.name}` }, options)
}

async function dispatch(state, positional, options, context = {}) {
  const [command, ...rest] = positional

  switch (command) {
    case undefined:
    case 'help':
      printHelp()
      return
    case 'open':
    case 'connect':
      await handleOpen(state, options)
      return
    case 'session':
      if (rest[0] === 'list') {
        await handleSessionList(options)
        return
      }
      throw new Error(`Unknown session command: ${rest[0] || '(empty)'}`)
    case 'close':
      await handleClose(state, options)
      return
    case 'path':
      await handlePath(state, options)
      return
    case 'app':
      if (rest[0] === 'inspect') {
        await handleAppInspect(state, options)
        return
      }
      throw new Error(`Unknown app command: ${rest[0] || '(empty)'}`)
    case 'relaunch':
    case 'goto':
      await handleRelaunch(state, rest[0], options)
      return
    case 'snapshot':
      await handleSnapshot(state, options, context.scopeRef || null)
      return
    case 'query':
      await handleQuery(state, rest[0], rest.slice(1).join(' '), options, context.scopeRef || null)
      return
    case 'within':
      await dispatch(state, rest.slice(1), options, { scopeRef: rest[0] })
      return
    case 'tap':
    case 'click':
      await handleTap(state, rest[0], options, context.scopeRef || null)
      return
    case 'input':
    case 'fill':
      await handleInput(state, rest[0], rest.slice(1).join(' '), options, context.scopeRef || null)
      return
    case 'wait':
      await handleWait(state, rest[0], options, context.scopeRef || null)
      return
    case 'get':
      await handleGet(state, rest[0], rest[1], rest[2], options, context.scopeRef || null)
      return
    case 'system-info':
      await handleSystemInfo(state, options)
      return
    case 'page-stack':
      await handlePageStack(state, options)
      return
    case 'timeline':
      await handleTimeline(state, rest[0], options)
      return
    case 'logs':
      await handleLogs(state, 'console', rest[0], options)
      return
    case 'exceptions':
      await handleLogs(state, 'exception', rest[0], options)
      return
    case 'eval':
      await handleEval(state, rest.join(' '), options)
      return
    case 'native':
      await handleNative(state, rest[0], rest.slice(1), options)
      return
    case 'call':
      await handleCall(state, rest[0], rest[1], rest.slice(2), options)
      return
    case 'screenshot':
      await handleScreenshot(state, rest[0], options)
      return
    default:
      throw new Error(`Unknown command: ${command}`)
  }
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2))
  const command = positional[0]

  if (options.version || command === 'version') {
    console.log(getVersionText())
    return
  }

  if (options.help) {
    if (command) {
      printCommandHelp(command)
      return
    }
    printHelp()
    return
  }

  if (command === undefined || command === 'help') {
    if (command === 'help' && positional[1]) {
      printCommandHelp(positional[1])
      return
    }
    printHelp()
    return
  }

  if (command === 'session' && positional[1] === 'list') {
    await handleSessionList(options)
    return
  }

  const baseConfig = createDefaultConfig()
  const lock = await acquireSessionLock(options.session, baseConfig, { command })

  try {
    const state = await resolveSession(options)
    await syncRouteTimelinePrelude(state, options, command)
    await dispatch(state, positional, options)
  } finally {
    await releaseSessionLock(lock)
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.message ? error.message : error)
    process.exit(1)
  })
}

module.exports = {
  buildHelpText,
  buildCommandHelpText,
  getVersionText,
  parseFocusRefs,
  shouldAttemptVisualProbe,
  shouldEmitPreludeNotices,
  summarizeTimelinePayload,
  summarizeSnapshotPayload,
}
