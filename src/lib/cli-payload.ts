/**
 * @param {Record<string, any>} payload
 * @param {{ all?: boolean }} options
 * @returns {Record<string, any>}
 */
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

/**
 * @param {Record<string, any>} payload
 * @param {{ all?: boolean }} options
 * @returns {Record<string, any>}
 */
function summarizeSnapshotPayload(payload, options) {
  if (options.all) {
    return payload
  }

  const records = Array.isArray(payload.records) ? payload.records.map((record) => ({
    ref: record.ref,
    kind: record.kind,
    text: record.text,
    route: record.route,
    ...(record.rectPct ? { rectPct: record.rectPct } : {}),
  })) : []

  const summary: Record<string, any> = {
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

module.exports = {
  summarizeSnapshotPayload,
  summarizeTimelinePayload,
}
