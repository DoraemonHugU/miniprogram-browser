const packageJson = require('../../package.json')

function buildHelpText() {
  return `miniprogram-browser - 微信小程序 agent-browser 风格 CLI

用法:
  miniprogram-browser <command> [args] [options]
  miniprogram-browser help <command>
  miniprogram-browser <command> --help
  miniprogram-browser -v | --version

核心命令（优先使用）:
  open                         确保拿到一个可用的小程序项目 session
  goto <route>                 重启到指定路由
  snapshot                     生成紧凑语义 refs 与 ASCII 空间图
  click <target>               点击 ref 或 selector
  fill <target> <text>         输入文本
  get <what> [target]          读取 text/value/count/data/path/attr/prop/rect
  await <condition>            显式等待运行态条件成立

诊断与结构（推荐）:
  app inspect                  输出应用结构摘要
  doctor                       分层诊断 DevTools/自动化/App 运行态
  devtools logs                查看 DevTools 底层日志
  protocol <method> [json]     调用自动化底层协议
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
  open                         优先沿用活动 session/attach 唯一 live runtime；多 runtime 无活动目标时明确 session；否则启动新 runtime
  connect                      open 的别名
  session list                 列出当前项目已绑定的 session
  session info [<name>]        查看活动或指定 session 的当前状态
  status [<name>]              session info 的短别名
  session prune                清理当前项目 stale session 和 orphan launch
  session kill <name>          关闭并解绑当前项目下的指定 session
  close                        关闭或解绑当前 session；attached session 默认只解绑
  path                         输出当前页面路径
  relaunch <route>             重启到指定路由
  wait <target|ms>             等待 ref、selector 或固定毫秒
  screenshot [path]            截图并输出文件路径（省略 path 时使用系统临时目录）
  help                         输出帮助

兼容别名:
  tap                          click 的别名
  input                        fill 的别名

常用选项:
  --session <name>             session 名称；省略时优先沿用活动 session，再按项目生成/复用 {project}-xN；多 runtime 且无活动目标时需显式
  --json                       以 JSON 输出
  --project <path>             当前 shell 可读的小程序项目根目录；可由当前 Git 工作树自动发现
  --fresh                      open 时强制请求新 runtime；失败不会静默降级为 attach
  --mode <page|visual|annotate|layout> 截图模式，默认 page（真实页面 PNG）
  --no-ref                     截图时不绘制 @eN 标签
  --await <condition>          动作后显式等待条件成立
  --follow                     动作完成后生成一次新的 refs 摘要（默认关闭，避免输出膨胀）
  --no-await                   关闭命令默认隐式等待
  --wait <ms>                  动作后固定等待；doctor 为轮询窗口，screenshot 为截图超时
  --timeout <ms>               条件等待 / protocol 的最大时长，条件满足可提前返回
  MINIPROGRAM_BROWSER_SESSION  显式设置当前 shell/Agent 的默认 session（命令行 --session 优先）
  --limit <n>                  logs/exceptions 默认输出条数
  --sections <a,b,c>           app inspect 指定输出分区
  --all                        app inspect 输出全部分区
  --stdin                      从标准输入读取 eval 脚本
  -v, --version                输出当前 CLI 版本号
  -d, --depth <n>              snapshot 时限制输出深度

高级诊断/环境选项:
  -c, --compact                压缩 screenshot --mode layout；snapshot 默认已经 compact
  --devtools-project <path>    传给 DevTools CLI 的项目路径；自动路径策略不可用时使用
  --project-map <linux=windows> WSL 路径前缀到 Windows 盘符前缀的显式映射
  --cli-path <path>            DevTools CLI 路径；也可用 WECHAT_DEVTOOLS_CLI
  --auto-port <port>           请求的自动化 ws 端口；本机 DevTools help 可能隐藏该选项，但 CLI 仍会透传给 /auto
  --devtools-port <port>       DevTools HTTP 端口；通常不传，默认由 DevTools 当前服务回显
`
}

function getVersionText() {
  return String(packageJson.version || '')
}

/**
 * @param {unknown} command
 * @returns {string}
 */
function buildCommandHelpText(command: unknown): string {
  const normalized = String(command || '').trim()
  switch (normalized) {
    case 'open':
    case 'connect':
      return `open/connect

用法:
  miniprogram-browser open [--session <name>] [--project <path>] [options]

作用:
  确保当前 session 绑定到一个可用的小程序 runtime。

关键点:
  - 可省略 --session：优先沿用项目活动 session；没有活动 session 时才按项目名生成/复用 {project}-xN（如 sample-store-x1）
  - 也可用 MINIPROGRAM_BROWSER_SESSION 设置 Agent/工作树默认 session；命令行 --session 优先
  - 显式 --session 仍可用于并行工作台（work/debug 等），成功 open/connect 后会成为该项目活动 session
  - --project 可由当前目录/Git 工作树自动发现
  - fresh session 下 autoPort 默认自动分配；显式 --auto-port 只在 fresh 启动时生效，attach 到已有 runtime 时会沿用 owner autoPort
  - 不要把 devtoolsPort 当默认隔离边界；显式 --devtools-port 只用于高级诊断/逃逸
  - 默认优先 attach 到同项目唯一 live runtime；没有可复用 runtime 时才尝试启动新的
  - open 默认等待 stable：App runtime 响应、页面路径/页面栈短暂稳定，并尝试读取通用视图树
  - 如果 Tool 层已连通但 App 仍在 warmup，open 会保留 session 并返回 appReady=false；业务动作前显式执行 await app-ready
  - 如果当前项目没有已启动的小程序 runtime，attach 不会发生，open 会走启动路径
  - 同项目存在多个不同 live runtime 时不会按“最新”静默选择；请显式使用目标 session 或传 --fresh
  - --fresh 表示“必须新起”；失败时不会偷偷 attach 到已有 runtime
  - DevTools debug 里的 ws connect <port> 是 CLI 自己的 /upgrade 长连接端口，不是 automation ws 端口
  - 同一 session 串行执行；不同 session 可以并发
  - 非标准安装路径 / WSL 场景下，可通过 WECHAT_DEVTOOLS_CLI 指定 CLI 路径
  - WSL 下 --project 仍指向本地可读路径；优先 /mnt/<drive>，必要时 --devtools-project / --project-map
  - 正常情况下不用手动传端口、路径映射或信任类参数；CLI 会自动处理

常用选项:
  --session <name>
  --project <path>

高级诊断/环境选项:
  --devtools-project <path>
  --project-map <linux=windows>
  --devtools-port <port>
  --auto-port <port>
  --fresh
  --cli-path <path>
  --trust-project               默认开启
  --no-trust-project            显式关闭信任

示例:
  miniprogram-browser open
  miniprogram-browser open --project /path/to/miniprogram-root
  miniprogram-browser open --session work
  miniprogram-browser open --fresh
`
    case 'goto':
    case 'relaunch':
      return `goto/relaunch

用法:
  miniprogram-browser goto <route> --session <name> [--wait <ms>] [--await <condition>] [--timeout <ms>] [--follow]

作用:
  重启到指定路由，并等待页面稳定；传 --follow 时在动作完成后返回一次新的 refs 摘要。
`
    case 'snapshot':
      return `snapshot

用法:
  miniprogram-browser snapshot --session <name> [--await <condition>] [--timeout <ms>] [--json]

作用:
  生成紧凑语义 refs（@eN）和 ASCII 空间图。

选项:
  --json           输出紧凑结构化记录
  --layout         在语义树中额外显示精确比例位置/尺寸
  --no-map         不输出 ASCII 空间图
  -d, --depth <n>  限制语义树层级
  --all            输出完整树和内部细节
`
    case 'click':
    case 'tap':
      return `click/tap

用法:
  miniprogram-browser click <target> --session <name> [--wait <ms>] [--await <condition>] [--timeout <ms>] [--follow]

作用:
  点击 ref 或 selector，并在同页未跳转时给出必要提示；传 --follow 时返回动作后的新 refs 摘要。
`
    case 'fill':
    case 'input':
      return `fill/input

用法:
  miniprogram-browser fill <target> <text> --session <name> [--wait <ms>] [--await <condition>] [--timeout <ms>] [--follow]

作用:
  向 ref 或 selector 输入文本；可固定等待或等待可观察条件，传 --follow 时返回输入后的新 refs 摘要。
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
    case 'doctor':
      return `doctor

用法:
  miniprogram-browser doctor --session <name> [--project <path>] [--wait <ms>] [--timeout <ms>] [--json]
  miniprogram-browser doctor --project <path> --devtools-port <port> [--wait <ms>] [--timeout <ms>] [--json]

作用:
  分层诊断 DevTools CLI、automation WebSocket 和小程序 App runtime。

说明:
  - 传 --session 时，优先诊断当前绑定的 runtime/session
  - 传 --project + --devtools-port 时，可预检一个已打开的 DevTools HTTP 服务是否能成功 bootstrap automation，而不落 session
  - 会先尝试启动/连接 DevTools 自动化
  - 启动后轮询真实运行态，App 就绪后立即返回；--wait 只限制轮询时长，--wait 0 表示单次探测
  - Tool.getInfo 成功但 App.* 超时，表示自动化服务已开但小程序运行态未就绪
  - WSL /home 项目会沿用 WSL UNC 路径直传策略
`
    case 'await':
      return `await

用法:
  miniprogram-browser await <condition> --session <name> [--timeout <ms>] [--json]

支持:
  tool-ready | app-ready | stable | route-change | route-settled
  route:/pages/index/index | selector:.submit | visible:.submit | hidden:.loading | ref:@e1

作用:
  显式等待单个条件成立；适合替代硬编码 sleep。stable 是通用运行态稳定条件，不依赖业务 selector。
`
    case 'devtools':
      return `devtools logs

用法:
  miniprogram-browser devtools logs --session <name> [--limit <n>] [--files <n>] [--grep <pattern>] [--json]

作用:
  读取微信开发者工具 WeappLog 底层日志；用于 App runtime 不响应、普通 logs/exceptions 拿不到信息时排障。
`
    case 'protocol':
      return `protocol

用法:
  miniprogram-browser protocol <method> [params-json] --session <name> [--timeout <ms>] [--json]

示例:
  miniprogram-browser protocol Tool.getInfo --session demo --json
  miniprogram-browser protocol App.callWxMethod '{"method":"getSystemInfoSync","args":[]}' --session demo --json

作用:
  调用自动化 WebSocket 的底层协议。只建议调试极端问题时使用。
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
  miniprogram-browser native <method> [...args] --session <name> [--await <condition>] [--timeout <ms>]

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
  数字参数会完整等待指定毫秒，例如 wait 1500；ref / selector 参数会轮询到目标出现。
  能描述结果时优先使用 await / --await；--timeout 是最长等待时间，不保证完整暂停。
`
    case 'screenshot':
      return `screenshot

用法:
  miniprogram-browser screenshot [path] --session <name> [--mode <page|visual|annotate|layout>] [--focus <refs>] [--no-ref] [--capsule] [--raw] [-c|--compact] [--wait <ms>] [--await <condition>] [--timeout <ms>] [--json]

模式:
  page      官方页面截图（默认）
  visual    页面截图 + 胶囊视觉合成
  annotate  页面截图 + @eNN 标注叠加
  layout    基于运行时 rect 的布局替代渲染

  说明:
  - 默认模式是 page；需要结构布局图时显式传 --mode layout
  - --focus 支持 @e1,@e2 这类多个 ref，高亮时会自动换色
  - --no-ref 会隐藏图片里的 @eN 标签，但不会影响 focus 框或 session/ref 解析
  - layout 默认用语义布局；加 --raw 可切到更底层的运行时节点布局
  - --capsule 可在 layout/visual 图上叠加右上角微信胶囊
  - 不传路径时保存到系统临时目录下的短文件名；同名冲突会自动追加 -1、-2……
  - path 可为相对或绝对文件路径；相对路径以当前工作目录为基准，缺失的父目录会自动创建
  - path 指向已有目录，或以目录分隔符结尾时，会在该目录内生成同样的短文件名
`
    case 'status':
      return `status

用法:
  miniprogram-browser status [<name>] [--project <path>] [--json]
  miniprogram-browser session info [<name>] [--project <path>] [--json]

作用:
  只读查看活动或指定 session 的状态，不启动 DevTools、不分配端口。

输出:
  session/active/status、project/route、runtime owner/attachedTo、autoPort/devtoolsPort、created/updated
`
    case 'session':
      return `session

用法:
  miniprogram-browser session list [--json] [--noise]
  miniprogram-browser session list --all [--json] [--noise]
  miniprogram-browser session info [<name>] [--json]
  miniprogram-browser status [<name>] [--json]
  miniprogram-browser session prune [--json]
  miniprogram-browser session kill <name> [--json]
  miniprogram-browser session close <name> [--json]

作用:
  查看或终止 session。默认按当前小程序项目隔离；从同一 Git 仓库的 sibling 目录执行时，也会自动发现 apps/miniprogram。

说明:
  - session list 默认只显示当前项目，状态包含 live/stale；session info/status 默认查看活动 session
  - 默认隐藏 gate/e2e/test 前缀的 stale 残留；加 --noise 看全量
  - 当前目录无法发现小程序项目时，默认返回空并提示；--all 才查看全局注册表
  - session prune 只清理当前项目 stale session 和本 CLI 记录的 orphan launch；会尝试关闭对应 DevTools 项目窗口
  - session kill/close <name> 会优先作用于当前项目，不会静默清理其他项目同名 session
  - attached session 默认只解绑自身并保留 owner runtime；需要关闭真实 runtime 时使用 owner session 或显式 --runtime
`
    case 'close':
      return `close

用法:
  miniprogram-browser close --session <name> [--runtime]

作用:
  关闭或解绑 session。attached session 默认只解绑自身；--runtime 才显式关闭底层 DevTools runtime。
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

module.exports = {
  buildCommandHelpText,
  buildHelpText,
  getVersionText,
}
