type AnyRecord = Record<string, any>

function detectAutomationStartupIssue(rawMessage) {
  const message = String(rawMessage || '').trim()
  if (!message) {
    return null
  }

  if (!/TypeError|Cannot read property|Cannot read properties/iu.test(message)) {
    return null
  }

  if (!/MinTabbarCount|getPreCompileOptions|checkTabbar|miniprogram-builder|appJSON\.js|checkAppFields\.js/iu.test(message)) {
    return null
  }

  return {
    message: 'DevTools 已启动，但当前项目在编译阶段失败（builder/checkTabbar）；这不是普通的 session/port 冲突。请先在微信开发者工具里确认当前项目能编译通过，再重试 open/connect。若终端里出现 checkTabbar、MinTabbarCount、getPreCompileOptions，优先检查 tabBar/custom-tab-bar 相关改动。',
    raw: message,
  }
}

function formatAutomationCliError(rawMessage) {
  const message = String(rawMessage || '').trim()
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

function parseAutomationCliFailure(result, config: AnyRecord = {}) {
  const raw = String((result && result.raw) || `${(result && result.stdout) || ''}${(result && result.stderr) || ''}`).trim()

  if (result && result.error) {
    const detail = result.error && result.error.message ? result.error.message : String(result.error)
    return {
      code: 'DEVTOOLS_CLI_ERROR',
      message: `Failed to start WeChat DevTools CLI: ${config.cliPath || '(empty)'}. ${detail}`,
      hint: detail,
      raw,
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

function detectAutomationCliProgressTimeout(result) {
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

function wrapConnectErrorWithStartupIssue(error, startupIssue) {
  if (!startupIssue || !startupIssue.message) {
    return error
  }

  const detail = error && error.message ? String(error.message).trim() : String(error || '').trim()
  const nextError = new Error(`${startupIssue.message}${detail ? `\n原始 connect 错误: ${detail}` : ''}`)
  ;(nextError as AnyRecord).raw = startupIssue.raw || detail
  ;(nextError as AnyRecord).cause = error
  return nextError
}

function parseResolvedIdePort(rawMessage) {
  const message = String(rawMessage || '')
  const match = message.match(/IDE server has started, listening on http:\/\/127\.0\.0\.1:(\d+)/iu)
  return match ? String(match[1]) : ''
}

module.exports = {
  detectAutomationStartupIssue,
  formatAutomationCliError,
  parseAutomationCliFailure,
  detectAutomationCliProgressTimeout,
  wrapConnectErrorWithStartupIssue,
  parseResolvedIdePort,
}
