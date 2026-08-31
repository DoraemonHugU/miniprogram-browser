function nextRefName(index: number): string {
  return `@e${index}`
}

function toSegment(label: string, value: string): string {
  return `${label}:${String(value)}`
}

function normalizeIdentityText(value: string): string {
  return String(value || '').replace(/\s+/gu, ' ').trim().slice(0, 80)
}

function resolveStableText(node: Record<string, unknown> | null | undefined): string {
  const text = node && typeof node === 'object' ? (node.identityText || node.text) as string | undefined : undefined
  return normalizeIdentityText(text || '')
}

function buildNodeIdentity(node: Record<string, unknown> | null | undefined): string | null {
  if (!node || typeof node !== 'object') {
    return null
  }

  if (node.registryId) {
    return toSegment('registry', node.registryId as string)
  }

  if (node.testid) {
    return toSegment('testid', node.testid as string)
  }

  if (node.businessKey) {
    return toSegment('business', node.businessKey as string)
  }

  if (node.scopeKey) {
    return toSegment('scope', node.scopeKey as string)
  }

  const normalizedText = resolveStableText(node)
  if (normalizedText && node.selector) {
    return `${toSegment((node.kind as string) || 'custom', node.selector as string)}|${toSegment('text', normalizedText)}`
  }

  if (node.selector) {
    return toSegment((node.kind as string) || 'custom', node.selector as string)
  }

  return null
}

function buildNodeSignature(node: Record<string, unknown> | null | undefined): string {
  if (!node || typeof node !== 'object') {
    return ''
  }

  return [
    (node.kind as string) || '',
    resolveStableText(node),
    (node.businessKey as string) || '',
    (node.selector as string) || '',
  ].join('|')
}

function buildScopedPath(parentPath: string | null, node: Record<string, unknown> | null | undefined, siblingOccurrences: Map<string, number>): string {
  const identity = buildNodeIdentity(node)
  if (!identity) {
    return parentPath || ''
  }

  const seenCount = siblingOccurrences.get(identity) || 0
  siblingOccurrences.set(identity, seenCount + 1)
  const occurrenceSuffix = seenCount > 0 ? `#${seenCount + 1}` : ''
  const segment = `${identity}${occurrenceSuffix}`

  return parentPath ? `${parentPath}/${segment}` : segment
}

function createTreeStrategy(node: Record<string, unknown>): { kind: string; value: string; selector: string; index: number } | null {
  const index = Number(node.index || 0)

  if (node.testid && node.selector) {
    return {
      kind: 'testid',
      value: String(node.testid),
      selector: String(node.selector),
      index,
    }
  }

  if (node.registryId && node.selector) {
    return {
      kind: 'registry',
      value: String(node.registryId),
      selector: String(node.selector),
      index,
    }
  }

  if (node.businessKey && node.selector) {
    return {
      kind: 'business',
      value: String(node.businessKey),
      selector: String(node.selector),
      index,
    }
  }

  if (node.scopeKey && node.selector) {
    return {
      kind: 'scope',
      value: String(node.scopeKey),
      selector: String(node.selector),
      index,
    }
  }

  if (node.selector) {
    return {
      kind: 'selector',
      value: String(node.selector),
      selector: String(node.selector),
      index,
    }
  }

  return null
}

function createRefRecordFromNode(node: Record<string, unknown>, options: Record<string, unknown> = {}): Record<string, unknown> | null {
  const strategy = createTreeStrategy(node)

  if (!strategy) {
    return null
  }

  return {
    ref: options.ref,
    epoch: options.epoch,
    route: options.route,
    stableKey: options.stableKey || null,
    parentRef: options.parentRef || null,
    scopeRef: options.scopeRef || null,
    strategy,
    registryId: node.registryId || null,
    testid: node.testid || null,
    businessKey: node.businessKey || null,
    scopeKey: node.scopeKey || null,
    selector: node.selector || null,
    kind: node.kind || 'custom',
    text: node.text || '',
    signature: buildNodeSignature(node),
  }
}

function allocateRef(stableKey: string, previousState: { stableKeyToRef?: Record<string, string> } | null, nextIndexState: { value: number }): string {
  const existingRef = previousState && previousState.stableKeyToRef
    ? previousState.stableKeyToRef[stableKey]
    : null

  if (existingRef) {
    return existingRef
  }

  const ref = nextRefName(nextIndexState.value)
  nextIndexState.value += 1
  return ref
}

function buildTreeSnapshotRecords({
  nodes,
  epoch,
  route,
  pageKey,
  startIndex = 1,
  scopeRef = null,
  previousState = null,
}: {
  nodes: Record<string, unknown>[]
  epoch: number
  route: string
  pageKey?: string
  startIndex?: number
  scopeRef?: string | null
  previousState?: { nextRefIndex?: number; stableKeyToRef?: Record<string, string> } | null
}): { records: Record<string, unknown>[]; nextIndex: number } {
  const records: Record<string, unknown>[] = []
  const nextIndexState = {
    value: Math.max(
      startIndex,
      previousState && Number(previousState.nextRefIndex)
        ? Number(previousState.nextRefIndex)
        : startIndex,
    ),
  }

  function visit(currentNodes: Record<string, unknown>[], parentRef: string | null, parentPath: string): void {
    const siblingOccurrences = new Map()

    for (const node of currentNodes || []) {
      const currentPath = buildScopedPath(parentPath, node, siblingOccurrences)
      const stablePath = node && node.canonicalPath ? String(node.canonicalPath) : currentPath
      const stableKey = stablePath ? `${pageKey || route}|${stablePath}` : null
      const ref = stableKey
        ? allocateRef(stableKey, previousState, nextIndexState)
        : nextRefName(nextIndexState.value++)

      const record = createRefRecordFromNode(node, {
        ref,
        epoch,
        route,
        stableKey,
        parentRef,
        scopeRef,
      })

      if (record) {
        records.push(record)
        visit(node.children as Record<string, unknown>[] || [], String(record.ref), currentPath)
      } else {
        visit(node.children as Record<string, unknown>[] || [], parentRef, currentPath)
      }
    }
  }

  visit((Array.isArray(nodes) ? nodes : [nodes]) as Record<string, unknown>[], null, '')

  return { records, nextIndex: nextIndexState.value }
}

function fallbackSignature(match: Record<string, unknown>): string {
  return [
    match.tagName || '',
    match.text || '',
    match.className || '',
  ].join('|')
}

function buildFallbackSnapshotRecords({ matches, epoch, route, startIndex = 1, scopeRef = null }: {
  matches: Record<string, unknown>[]
  epoch: number
  route: string
  startIndex?: number
  scopeRef?: string | null
}): { records: Record<string, unknown>[]; nextIndex: number } {
  const records = []
  const seen = new Set()
  let nextIndex = startIndex

  for (const match of matches || []) {
    const signature = fallbackSignature(match)

    if (seen.has(signature)) {
      continue
    }

    seen.add(signature)
    records.push({
      ref: nextRefName(nextIndex),
      epoch,
      route,
      parentRef: null,
      scopeRef,
      strategy: {
        kind: 'selector',
        value: String(match.selector),
        selector: String(match.selector),
        index: Number(match.index || 0),
      },
      registryId: null,
      testid: null,
      selector: String(match.selector),
      kind: match.tagName || 'custom',
      text: match.text || '',
    })
    nextIndex += 1
  }

  return { records, nextIndex }
}

function formatSnapshotLines(records: Record<string, unknown>[], options: Record<string, unknown> = {}): string[] {
  const recordsByRef = new Map<string, Record<string, unknown>>((records || []).map((record: Record<string, unknown>) => [String(record.ref), record]))
  const depthCache = new Map<string, number>()

  function resolveDepth(record: Record<string, unknown>): number {
    if (!record || !record.parentRef) {
      return 0
    }

    if (depthCache.has(String(record.ref))) {
      return depthCache.get(String(record.ref))!
    }

    const parentDepth = resolveDepth(recordsByRef.get(String(record.parentRef)) ?? {}) + 1
    depthCache.set(String(record.ref), parentDepth)
    return parentDepth
  }

  function formatLayout(record: Record<string, unknown>): string {
    if (!options.layout || !record || !record.rectPct) {
      return ''
    }

    const rp = record.rectPct as Record<string, number>
    const x = rp.x, y = rp.y, w = rp.w, h = rp.h
    return ` {x:${x},y:${y},w:${w},h:${h}}`
  }

  return (records || []).map((record) => {
    const indent = '  '.repeat(resolveDepth(record))
    const prefix = `${String(record.ref)} [${String(record.kind || 'custom')}]`
    const text = String(record.text || '').trim()
    const base = text ? `${indent}${prefix} ${text}` : `${indent}${prefix}`
    return `${base}${formatLayout(record)}`
  })
}

module.exports = {
  nextRefName,
  createRefRecordFromNode,
  buildTreeSnapshotRecords,
  buildFallbackSnapshotRecords,
  formatSnapshotLines,
}
