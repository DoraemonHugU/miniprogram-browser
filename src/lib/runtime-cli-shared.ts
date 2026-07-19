/**
 * runtime-cli-shared.ts — DevTools CLI 消息解析共享工具
 *
 * 产品原则：
 * - 能识别的失败用人话说明
 * - 始终保留底层原始输出（raw），不要用本项目包装语盖掉根因
 * - 不强制稳定 code / next action
 */

type ErrorWithMeta = Error & { raw?: string; cause?: unknown; hint?: string; code?: string }

function detectAutomationStartupIssue(rawMessage: string): { message: string; raw: string } | null {
  const message = String(rawMessage || '').trim()
  if (!message) {
    return null
  }

  if (!/TypeError|Cannot read property|Cannot read properties/iu.test(message)) {
    return null
  }

  if (!/MinTabbarCount|getPreCompileOptions|checkTabbar|miniprogram-builder|appJSON\.js|checkAppFields\.js|subPackages.*undefined|simulator.*launch.*catch.*error/iu.test(message)) {
    return null
  }

  const isSubPackagesError = /Cannot read property ['"]subPackages['"] of undefined/iu.test(message)
  return {
    message: isSubPackagesError
      ? 'DevTools 已启动，但当前项目在模拟器启动阶段失败：app.json 中 subPackages 格式异常。请先在微信开发者工具里打开该项目手动编译一次，确认模拟器能正常渲染。常见原因：app.json 使用了非标准的子包结构。'
      : 'DevTools 已启动，但当前项目在编译阶段失败（builder/checkTabbar）；这不是普通的 session/port 冲突。请先在微信开发者工具里确认当前项目能编译通过，再重试 open/connect。若终端里出现 checkTabbar、MinTabbarCount、getPreCompileOptions，优先检查 tabBar/custom-tab-bar 相关改动。',
    raw: message,
  }
}

/**
 * 从 DevTools CLI / 日志原文提取可理解的说明。
 * 返回 null 表示没有更高层解释，调用方应继续使用原文。
 */
function explainDevtoolsFailureRaw(rawMessage: string): string | null {
  const message = String(rawMessage || '').trim()
  if (!message) {
    return null
  }

  if (/INVALID_LOGIN|access_token\s*expired|errcode\s*=\s*42001|code:\s*10\b/iu.test(message)) {
    return '微信开发者工具登录态失效（access_token 过期 / INVALID_LOGIN）。自动化无法在未登录状态下启用；请在 DevTools 中重新登录后再 open/connect。底层原始错误见 raw。'
  }

  if (/appid missing|errcode\s*=\s*41002|Fetching AppID \(\) permissions/iu.test(message) && /41002|appid missing|AppID \(\)/iu.test(message)) {
    return 'DevTools 未能读取到有效 AppID（常见 41002 / appid missing）。请确认项目 project.config 中 AppID 配置正确，并在开发者工具中能正常打开该项目。底层原始错误见 raw。'
  }

  if (/not login|islogin.*false|please login|请先登录/iu.test(message)) {
    return '微信开发者工具当前未登录。请先完成 DevTools 登录，再重试 open/connect。底层原始错误见 raw。'
  }

  return null
}

function formatAutomationCliError(rawMessage: string): { message: string; raw: string } {
  const message = String(rawMessage || '').trim()
  const explained = explainDevtoolsFailureRaw(message)
  if (explained) {
    return {
      message: explained,
      raw: message,
    }
  }

  const restartMatch = message.match(/IDE server has started on http:\/\/127\.0\.0\.1:(\d+) and must be restarted on port (\d+) first/u)
  if (restartMatch) {
    const [, currentPort, targetPort] = restartMatch
    return {
      message: `需要先把当前 DevTools HTTP 服务从 ${currentPort} 重启到 ${targetPort}，然后再绑定这个新 session；可先 close 当前 session 或在微信开发者工具里重启服务端口。`,
      raw: message,
    }
  }

  const initializeMatch = message.match(/IDE may already started at port\s+(\d+),\s*trying to connect/iu)
  if (initializeMatch && /wait IDE port timeout/iu.test(message)) {
    const [, port] = initializeMatch
    return {
      message: `检测到已有 DevTools IDE 实例正在使用端口 ${port}，但这次 attach 连接超时；通常说明该 DevTools 实例当前不健康、仍在初始化，或已经卡住。请先完全关闭微信开发者工具后重试 open；如果确认该 IDE 仍可用，也可稍后重试 open。`,
      raw: message,
    }
  }

  const startupIssue = detectAutomationStartupIssue(message)
  if (startupIssue) {
    return startupIssue
  }

  return { message, raw: message }
}

function parseAutomationCliFailure(result: { error?: Error; raw?: string; stdout?: string; stderr?: string; status?: number } | null, config: Record<string, unknown> = {}) {
  const raw = String((result && result.raw) || `${(result && result.stdout) || ''}${(result && result.stderr) || ''}`).trim()

  if (result && result.error) {
    const detail = result.error && result.error.message ? result.error.message : String(result.error)
    const explained = explainDevtoolsFailureRaw(`${detail}\n${raw}`)
    return {
      code: 'DEVTOOLS_CLI_ERROR',
      message: explained || `Failed to start WeChat DevTools CLI: ${config.cliPath || '(empty)'}. ${detail}`,
      hint: detail,
      raw: raw || detail,
    }
  }

  if (/QR_PATH_NOT_VALID_OR_NOT_EXIST|二维码输出路径无效或不存在|code:\s*17|\[error\]\s*code:\s*17/iu.test(raw)) {
    return {
      code: 'DEVTOOLS_CLI_ERROR',
      message: 'WeChat DevTools CLI reported code 17 / QR_PATH_NOT_VALID_OR_NOT_EXIST. This is commonly triggered when DevTools receives an unsupported project path, especially a WSL UNC path. Put the project under /mnt/<drive>/..., pass --devtools-project <Windows drive path>, or configure --project-map <linux=windows> / WECHAT_DEVTOOLS_PROJECT_MAP for a transparent WSL prefix mapping.',
      hint: 'code=17; QR_PATH_NOT_VALID_OR_NOT_EXIST',
      raw,
    }
  }

  // 登录失效等关键失败：优先人话，raw 保留完整底层输出
  const explained = explainDevtoolsFailureRaw(raw)
  if (explained) {
    const signalLine = raw.split(/\r?\n/u).find((line) => /INVALID_LOGIN|access_token|41002|42001|code:\s*10\b/iu.test(line))
      || raw.split(/\r?\n/u).find((line) => /^\s*\[error\]/iu.test(line))
      || raw
    return {
      code: 'DEVTOOLS_CLI_ERROR',
      message: explained,
      hint: signalLine.trim(),
      raw,
    }
  }

  if (/^\s*\[error\]/imu.test(raw)) {
    const firstErrorLine = raw.split(/\r?\n/u).find((line) => /^\s*\[error\]/iu.test(line)) || raw
    return {
      code: 'DEVTOOLS_CLI_ERROR',
      message: `WeChat DevTools CLI reported an error: ${firstErrorLine.trim()}`,
      hint: firstErrorLine.trim(),
      raw,
    }
  }

  if (result && result.status !== 0) {
    return formatAutomationCliError(raw || `WeChat DevTools CLI exited with status ${result.status}`)
  }

  return null
}

function detectAutomationCliProgressTimeout(result: { error?: Error; raw?: string; stdout?: string; stderr?: string } | null): { raw: string; message: string } | null {
  if (!result || !result.error) {
    return null
  }

  const detail = result.error && result.error.message ? String(result.error.message) : String(result.error)
  if (!/ETIMEDOUT|timed out/iu.test(detail)) {
    return null
  }

  const raw = String(result.raw || `${result.stdout || ''}${result.stderr || ''}`)
  if (!/IDE server has started, listening on http:\/\/127\.0\.0\.1:|long connection established|Using AppID:/iu.test(raw)) {
    return null
  }

  return {
    raw: raw.trim(),
    message: detail,
  }
}

function wrapConnectErrorWithStartupIssue(error: unknown, startupIssue: { message: string; raw?: string } | null): Error {
  if (!startupIssue || !startupIssue.message) {
    return error instanceof Error ? error : new Error(String(error))
  }

  const detail = error && typeof error === 'object' && 'message' in error
    ? String((error as Error).message).trim()
    : String(error || '').trim()
  const nextError = new Error(`${startupIssue.message}${detail ? `\n原始 connect 错误: ${detail}` : ''}`) as ErrorWithMeta
  nextError.raw = startupIssue.raw || detail
  nextError.cause = error
  return nextError
}

function parseResolvedIdePort(rawMessage: string): string {
  const message = String(rawMessage || '')
  const match = message.match(/IDE server has started, listening on http:\/\/127\.0\.0\.1:(\d+)/iu)
  return match ? String(match[1]) : ''
}

module.exports = {
  detectAutomationStartupIssue,
  explainDevtoolsFailureRaw,
  formatAutomationCliError,
  parseAutomationCliFailure,
  detectAutomationCliProgressTimeout,
  wrapConnectErrorWithStartupIssue,
  parseResolvedIdePort,
}
