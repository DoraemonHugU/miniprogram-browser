type CliOptions = Record<string, any> & {
  session: string
  sessionProvided: boolean
  json: boolean
  focus?: string
  _notices?: string[]
}

type ParsedCliArgs = {
  positional: string[]
  options: CliOptions
}

/**
 * @param {string} key
 * @returns {string}
 */
function toCamelOptionKey(key) {
  return key.replace(/-([a-z])/gu, (_match, char) => String(char).toUpperCase())
}

/**
 * @param {string[]} argv
 * @returns {ParsedCliArgs}
 */
function parseArgs(argv) {
  const positional: string[] = []
  const options: CliOptions = {
    session: 'default',
    sessionProvided: false,
    json: false,
  }
  const booleanFlags = new Set([
    'json',
    'help',
    'version',
    'compact',
    'all',
    'stdin',
    'layout',
    'raw',
    'capsule',
    'no-ref',
    'capture-screenshot',
    'fresh',
    'runtime',
    'no-await',
  ])

  function readOptionValue(flag, index) {
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('-')) {
      const error = new Error(`Option --${flag} requires a value.`) as Error & { code?: string }
      error.code = 'CLI_USAGE_ERROR'
      throw error
    }
    return value
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
      options.depth = readOptionValue('depth', index)
      index += 1
      continue
    }

    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }

    const key = token.slice(2)
    if (key === 'no-trust-project') {
      options.trustProject = false
      continue
    }

    const normalizedKey = toCamelOptionKey(key)
    if (booleanFlags.has(key)) {
      options[normalizedKey] = true
      continue
    }

    const value = readOptionValue(key, index)
    if (normalizedKey === 'focus' && typeof options.focus === 'string') {
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

/**
 * @param {Record<string, any>} payload
 * @param {CliOptions} options
 * @returns {void}
 */
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

/**
 * @param {string} message
 * @param {CliOptions} options
 * @returns {void}
 */
function emitProgress(message, options) {
  if (options.json || !message) {
    return
  }
  process.stderr.write(`${message}\n`)
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
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

module.exports = {
  emit,
  emitProgress,
  parseArgs,
  parseFocusRefs,
}
