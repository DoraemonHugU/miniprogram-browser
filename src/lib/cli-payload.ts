/**
 * @param {Record<string, unknown>} payload
 * @param {{ all?: boolean }} options
 * @returns {Record<string, unknown>}
 */
function summarizeTimelinePayload(payload: Record<string, unknown>, options: { all?: boolean }): Record<string, unknown> {
  if (options.all) {
    return payload
  }

  const events = Array.isArray(payload.events) ? (payload.events as Record<string, unknown>[]) : []
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
 * @param {Record<string, unknown>} payload
 * @param {{ all?: boolean }} options
 * @returns {Record<string, unknown>}
 */
function summarizeSnapshotPayload(payload: Record<string, unknown>, options: { all?: boolean }): Record<string, unknown> {
  if (options.all) {
    return payload
  }

  const records = Array.isArray(payload.records) ? (payload.records as Record<string, unknown>[]).map((record) => ({
    ref: record.ref,
    kind: record.kind,
    text: record.text,
    route: record.route,
    ...(record.rectPct ? { rectPct: record.rectPct } : {}),
  })) : []

  const summary: Record<string, unknown> = {
    route: payload.state && (payload.state as Record<string, unknown>).route ? (payload.state as Record<string, unknown>).route : null,
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
