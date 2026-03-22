function nextRefName(index) {
  return `@e${index}`
}

function toSegment(label, value) {
  return `${label}:${String(value)}`
}

function buildNodeIdentity(node) {
  if (!node || typeof node !== 'object') {
    return null
  }

  if (node.registryId) {
    return toSegment('registry', node.registryId)
  }

  if (node.testid) {
    return toSegment('testid', node.testid)
  }

  if (node.businessKey) {
    return toSegment('business', node.businessKey)
  }

  if (node.scopeKey) {
    return toSegment('scope', node.scopeKey)
  }

  if (node.selector) {
    return toSegment(node.kind || 'custom', node.selector)
  }

  return null
}

function buildScopedPath(parentPath, node, siblingOccurrences) {
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

function createTreeStrategy(node) {
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

function createRefRecordFromNode(node, options = {}) {
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
  }
}

function allocateRef(stableKey, previousState, nextIndexState) {
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
}) {
  const records = []
  const nextIndexState = {
    value: Math.max(
      startIndex,
      previousState && Number(previousState.nextRefIndex)
        ? Number(previousState.nextRefIndex)
        : startIndex,
    ),
  }

  function visit(currentNodes, parentRef, parentPath) {
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
        visit(node.children || [], record.ref, currentPath)
      } else {
        visit(node.children || [], parentRef, currentPath)
      }
    }
  }

  visit(Array.isArray(nodes) ? nodes : [nodes], null, '')

  return { records, nextIndex: nextIndexState.value }
}

function fallbackSignature(match) {
  return [
    match.tagName || '',
    match.text || '',
    match.className || '',
  ].join('|')
}

function buildFallbackSnapshotRecords({ matches, epoch, route, startIndex = 1, scopeRef = null }) {
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

function formatSnapshotLines(records) {
  const recordsByRef = new Map((records || []).map((record) => [record.ref, record]))
  const depthCache = new Map()

  function resolveDepth(record) {
    if (!record || !record.parentRef) {
      return 0
    }

    if (depthCache.has(record.ref)) {
      return depthCache.get(record.ref)
    }

    const parentDepth = resolveDepth(recordsByRef.get(record.parentRef)) + 1
    depthCache.set(record.ref, parentDepth)
    return parentDepth
  }

  return (records || []).map((record) => {
    const indent = '  '.repeat(resolveDepth(record))
    const prefix = `${record.ref} [${record.kind || 'custom'}]`
    const text = String(record.text || '').trim()
    return text ? `${indent}${prefix} ${text}` : `${indent}${prefix}`
  })
}

module.exports = {
  nextRefName,
  createRefRecordFromNode,
  buildTreeSnapshotRecords,
  buildFallbackSnapshotRecords,
  formatSnapshotLines,
}
