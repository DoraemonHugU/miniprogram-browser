const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  nextRefName,
  buildTreeSnapshotRecords,
  buildFallbackSnapshotRecords,
  formatSnapshotLines,
} = require('../scripts/lib/core.cjs')

const {
  acquireSessionLock,
  assertProjectPath,
  assertBindingConsistency,
  assertNoDevtoolsConflict,
  clearSessionState,
  listSessionStates,
  loadSessionState,
  mergeConfigOverrides,
  prepareSessionStateForSave,
  createDefaultConfig,
  createEmptySessionState,
  assignPorts,
  ensureSessionPorts,
  saveSessionState,
  sessionLockPath,
  sessionLockRoot,
  validateSessionPortConflicts,
  releaseSessionLock,
} = require('../scripts/lib/session-store.cjs')

test('nextRefName generates agent-browser style refs', () => {
  assert.equal(nextRefName(1), '@e1')
  assert.equal(nextRefName(12), '@e12')
})

test('buildTreeSnapshotRecords keeps stable resolver metadata', () => {
  const result = buildTreeSnapshotRecords({
    nodes: [
      {
        registryId: 'todo.card',
        selector: '.todo-card',
        kind: 'card',
        text: 'Todo card',
        children: [
          {
            testid: 'todo.save',
            selector: '.todo-save',
            kind: 'button',
            text: '保存',
          },
        ],
      },
    ],
    epoch: 3,
    route: 'pages/dashboard/index',
    pageKey: 'pages/dashboard/index',
  })

  assert.equal(result.records.length, 2)
  assert.deepEqual(result.records[0].strategy, {
    kind: 'registry',
    value: 'todo.card',
    selector: '.todo-card',
    index: 0,
  })
  assert.deepEqual(result.records[1].strategy, {
    kind: 'testid',
    value: 'todo.save',
    selector: '.todo-save',
    index: 0,
  })
  assert.equal(result.records[1].parentRef, '@e1')
  assert.equal(result.records[1].epoch, 3)
  assert.equal(result.records[1].route, 'pages/dashboard/index')
  assert.equal(result.records[1].stableKey, 'pages/dashboard/index|registry:todo.card/testid:todo.save')
  assert.equal('element' in result.records[1], false)
})

test('buildTreeSnapshotRecords reuses refs for stable nodes and appends new refs', () => {
  const previousState = {
    nextRefIndex: 3,
    stableKeyToRef: {
      'pages/dashboard/index|registry:todo.card': '@e1',
      'pages/dashboard/index|registry:todo.card/testid:todo.save': '@e2',
    },
  }

  const result = buildTreeSnapshotRecords({
    nodes: [
      {
        registryId: 'todo.card',
        selector: '.todo-card',
        kind: 'card',
        children: [
          {
            testid: 'todo.save',
            selector: '.todo-save',
            kind: 'button',
            text: '保存',
          },
        ],
      },
      {
        registryId: 'modal.todo-sheet',
        selector: '.todo-sheet',
        kind: 'sheet',
        children: [
          {
            testid: 'todo.confirm',
            selector: '.todo-confirm',
            kind: 'button',
            text: '确定',
          },
        ],
      },
    ],
    epoch: 4,
    route: 'pages/dashboard/index',
    pageKey: 'pages/dashboard/index',
    previousState,
  })

  assert.deepEqual(
    result.records.map((record) => record.ref),
    ['@e1', '@e2', '@e3', '@e4'],
  )
  assert.equal(result.records[2].stableKey, 'pages/dashboard/index|registry:modal.todo-sheet')
  assert.equal(result.nextIndex, 5)
})

test('buildTreeSnapshotRecords separates entities by pageKey', () => {
  const previousState = {
    nextRefIndex: 2,
    stableKeyToRef: {
      'pages/detail/index?id=1|registry:detail.title': '@e1',
    },
  }

  const result = buildTreeSnapshotRecords({
    nodes: [
      {
        registryId: 'detail.title',
        selector: '.detail-title',
        kind: 'text',
        text: '标题',
      },
    ],
    epoch: 2,
    route: 'pages/detail/index',
    pageKey: 'pages/detail/index?id=2',
    previousState,
  })

  assert.equal(result.records[0].ref, '@e2')
  assert.equal(result.records[0].stableKey, 'pages/detail/index?id=2|registry:detail.title')
})

test('buildFallbackSnapshotRecords deduplicates by signature', () => {
  const result = buildFallbackSnapshotRecords({
    matches: [
      {
        selector: 'button',
        index: 0,
        tagName: 'button',
        text: '保存',
        className: 'primary-button',
      },
      {
        selector: '.primary-button',
        index: 0,
        tagName: 'button',
        text: '保存',
        className: 'primary-button',
      },
    ],
    epoch: 2,
    route: 'pages/todo/index',
  })

  assert.equal(result.records.length, 1)
  assert.deepEqual(result.records[0].strategy, {
    kind: 'selector',
    value: 'button',
    selector: 'button',
    index: 0,
  })
})

test('formatSnapshotLines outputs readable interactive refs', () => {
  const output = formatSnapshotLines([
    { ref: '@e1', kind: 'button', text: '保存' },
    { ref: '@e2', kind: 'view', text: '', parentRef: '@e1' },
    { ref: '@e3', kind: 'input', text: '', parentRef: '@e2' },
  ])

  assert.deepEqual(output, [
    '@e1 [button] 保存',
    '  @e2 [view]',
    '    @e3 [input]',
  ])
})

test('createDefaultConfig uses apps/miniprogram root projectPath', () => {
  const config = createDefaultConfig('/repo')
  assert.equal(config.projectPath, '')
  assert.equal(config.devtoolsPort, '')
  assert.equal(config.autoPort, '')
  assert.equal(typeof config.cliPath, 'string')
})

test('assertProjectPath requires explicit mini-program root path', () => {
  assert.throws(
    () => assertProjectPath({ projectPath: '' }),
    /--project/i,
  )

  assert.doesNotThrow(() => {
    assertProjectPath({ projectPath: '/worktree-a/apps/miniprogram' })
  })
})

test('mergeConfigOverrides keeps stored projectPath when caller omits it', () => {
  const merged = mergeConfigOverrides(
    {
      projectPath: '/worktree-a/apps/miniprogram',
      cliPath: '/cli.bat',
      devtoolsPort: '39085',
      autoPort: '9422',
    },
    {},
  )

  assert.equal(merged.projectPath, '/worktree-a/apps/miniprogram')
  assert.equal(merged.autoPort, '9422')
  assert.equal(merged.devtoolsPort, '39085')
})

test('assertBindingConsistency rejects changing a bound session', () => {
  assert.throws(
    () => assertBindingConsistency(
      {
        projectPath: '/worktree-a/apps/miniprogram',
        autoPort: '9422',
        devtoolsPort: '39085',
      },
      {
        projectPath: '/worktree-b/apps/miniprogram',
      },
    ),
    /already bound/i,
  )

  assert.throws(
    () => assertBindingConsistency(
      {
        projectPath: '/worktree-a/apps/miniprogram',
        autoPort: '9422',
      },
      {
        autoPort: '9423',
      },
    ),
    /already bound/i,
  )

  assert.doesNotThrow(() => {
    assertBindingConsistency(
      {
        projectPath: '/worktree-a/apps/miniprogram',
        autoPort: '9422',
        devtoolsPort: '39085',
      },
      {
        devtoolsPort: '39090',
      },
    )
  })
})

test('assertNoDevtoolsConflict allows reusing devtoolsPort across projects', () => {
  assert.doesNotThrow(() => {
    assertNoDevtoolsConflict(
      {
        projectPath: '/worktree-b/apps/miniprogram',
        devtoolsPort: '39085',
        autoPort: '9424',
      },
      [
        {
          name: 'session-a',
          config: {
            projectPath: '/worktree-a/apps/miniprogram',
            devtoolsPort: '39085',
            autoPort: '9423',
          },
        },
      ],
    )
  })
})

test('validateSessionPortConflicts rejects reusing an autoPort from another session', () => {
  assert.throws(
    () => validateSessionPortConflicts(
      {
        projectPath: '/worktree-a/apps/miniprogram',
        autoPort: '9422',
        devtoolsPort: '39085',
      },
      [
        {
          name: 'other',
          config: {
            projectPath: '/worktree-b/apps/miniprogram',
            autoPort: '9422',
            devtoolsPort: '39090',
          },
        },
      ],
    ),
    /autoPort 9422 is already bound/i,
  )
})

test('assignPorts rejects caller-specified autoPort already used by another session', async () => {
  await assert.rejects(
    assignPorts(
      {
        projectPath: '/worktree-a/apps/miniprogram',
        devtoolsPort: '39085',
        autoPort: '9422',
      },
      [
        {
          name: 'other',
          config: {
            projectPath: '/worktree-b/apps/miniprogram',
            devtoolsPort: '39090',
            autoPort: '9422',
          },
        },
      ],
      async () => true,
    ),
    /autoPort 9422 is already bound/i,
  )
})

test('ensureSessionPorts assigns missing autoPort for a fresh session', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mpb-fresh-'))
  try {
    const state = {
      name: 'fresh',
      config: {
        sessionDir: tempDir,
        projectPath: '/worktree-a/apps/miniprogram',
        devtoolsPort: '',
        autoPort: '',
      },
    }

    const result = await ensureSessionPorts(state, async () => true)
    assert.equal(result.config.devtoolsPort, '')
    assert.equal(result.config.autoPort, '9421')
    assert.equal(result.portResolution.devtoolsPortAssigned, false)
    assert.equal(result.portResolution.autoPortAssigned, true)
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true })
  }
})

test('ensureSessionPorts avoids reserved auto ports for fresh session', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mpb-fresh-reserved-'))
  try {
    await fs.promises.writeFile(path.join(tempDir, 'other.json'), JSON.stringify({
      config: {
        projectPath: '/worktree-b/apps/miniprogram',
        devtoolsPort: '39085',
        autoPort: '9421',
      },
    }))

    const state = {
      name: 'fresh',
      config: {
        sessionDir: tempDir,
        projectPath: '/worktree-a/apps/miniprogram',
        devtoolsPort: '',
        autoPort: '',
      },
    }

    const result = await ensureSessionPorts(state, async () => true)
    assert.equal(result.config.autoPort, '9422')
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true })
  }
})

test('createEmptySessionState starts with empty refs and epoch zero', () => {
  const state = createEmptySessionState({
    sessionName: 'default',
    config: createDefaultConfig('/repo'),
  })

  assert.equal(state.name, 'default')
  assert.equal(state.epoch, 0)
  assert.deepEqual(state.refs, {})
})

test('assignPorts keeps caller-specified ports', async () => {
  const config = createDefaultConfig('/repo')
  const assigned = await assignPorts({
    ...config,
    devtoolsPort: '40100',
    autoPort: '9510',
  }, [], async () => true)

  assert.equal(assigned.devtoolsPort, '40100')
  assert.equal(assigned.autoPort, '9510')
})

test('assignPorts auto-selects free ports away from reserved ones', async () => {
  const config = createDefaultConfig('/repo')
  const assigned = await assignPorts({
    ...config,
    devtoolsPort: '39086',
    autoPort: '',
  }, [
    { devtoolsPort: '39085', autoPort: '9421' },
    { devtoolsPort: '39085', autoPort: '9422' },
  ], async (port) => ![39087, 9423].includes(port))

  assert.equal(assigned.devtoolsPort, '39086')
  assert.equal(assigned.autoPort, '9424')
})

test('prepareSessionStateForSave prunes oldest inactive refs', () => {
  const state = {
    name: 'demo',
    config: { sessionDir: '/tmp' },
    refs: {
      '@e1': { ref: '@e1', stableKey: 'a', active: false, lastSeenEpoch: 1 },
      '@e2': { ref: '@e2', stableKey: 'b', active: false, lastSeenEpoch: 2 },
      '@e3': { ref: '@e3', stableKey: 'c', active: true, lastSeenEpoch: 3 },
    },
    stableKeyToRef: {
      a: '@e1',
      b: '@e2',
      c: '@e3',
    },
  }

  const prepared = prepareSessionStateForSave(state, { maxInactiveRefs: 1 })

  assert.deepEqual(Object.keys(prepared.refs).sort(), ['@e2', '@e3'])
  assert.deepEqual(prepared.stableKeyToRef, { b: '@e2', c: '@e3' })
})

test('prepareSessionStateForSave trims runtime event buffers', () => {
  const prepared = prepareSessionStateForSave({
    consoleEvents: [{ id: 1 }, { id: 2 }, { id: 3 }],
    exceptionEvents: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    routeEvents: [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }],
  }, { maxRuntimeEvents: 2, maxRouteEvents: 2 })

  assert.deepEqual(prepared.consoleEvents, [{ id: 2 }, { id: 3 }])
  assert.deepEqual(prepared.exceptionEvents, [{ id: 'b' }, { id: 'c' }])
  assert.deepEqual(prepared.routeEvents, [{ id: 'r2' }, { id: 'r3' }])
})

test('listSessionStates returns compact session summaries', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mp-browser-sessions-'))
  try {
    await fs.promises.writeFile(path.join(dir, 'demo.json'), JSON.stringify({
      config: {
        projectPath: '/worktree-a/apps/miniprogram',
        devtoolsPort: '39085',
        autoPort: '9421',
      },
      route: 'pages/dashboard/index',
    }))

    const states = await listSessionStates(dir)

    assert.ok(Array.isArray(states))
    assert.ok(states.every((item) => typeof item.name === 'string'))
    assert.ok(states.every((item) => 'projectPath' in item && 'devtoolsPort' in item && 'autoPort' in item))
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true })
  }
})

test('acquireSessionLock serializes same session name', async () => {
  const sessionDir = path.join(os.tmpdir(), `mp-browser-lock-${Date.now()}`)
  const config = { sessionDir }

  const first = await acquireSessionLock('demo', config, { timeoutMs: 50, pollMs: 5 })
  await assert.rejects(
    acquireSessionLock('demo', config, { timeoutMs: 30, pollMs: 5 }),
    /lock timeout/i,
  )

  await releaseSessionLock(first)
  const second = await acquireSessionLock('demo', config, { timeoutMs: 50, pollMs: 5 })
  await releaseSessionLock(second)
})

test('sessionLockRoot uses project git metadata when projectPath is set', async () => {
  const projectDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mpb-project-'))
  try {
    await fs.promises.mkdir(path.join(projectDir, '.git'), { recursive: true })
    const config = {
      ...createDefaultConfig('/repo'),
      projectPath: projectDir,
    }
    const root = sessionLockRoot(config)
    assert.equal(root, path.join(projectDir, '.git', 'miniprogram-browser', 'locks'))
  } finally {
    await fs.promises.rm(projectDir, { recursive: true, force: true })
  }
})

test('sessionLockRoot falls back to OS tmp dir when projectPath is unknown', () => {
  const config = createDefaultConfig('/repo')
  const root = sessionLockRoot(config)
  assert.equal(root.startsWith(os.tmpdir()), true)
})

test('saveSessionState stores session under project scope and loadSessionState resolves by registry', async () => {
  const projectDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mpb-project-state-'))
  const registryFile = path.join(os.tmpdir(), `mpb-registry-${Date.now()}.json`)

  try {
    await fs.promises.mkdir(path.join(projectDir, '.git'), { recursive: true })
    const config = {
      ...createDefaultConfig('/repo'),
      projectPath: projectDir,
      sessionRegistryFile: registryFile,
    }
    const state = createEmptySessionState({ sessionName: 'branch-a', config })
    state.route = 'pages/dashboard/index'
    state.config.autoPort = '9427'

    await saveSessionState(state)

    const loaded = await loadSessionState('branch-a', {
      ...createDefaultConfig('/repo'),
      sessionRegistryFile: registryFile,
    })

    assert.equal(loaded.config.projectPath, projectDir)
    assert.equal(loaded.config.sessionDir, path.join(projectDir, '.git', 'miniprogram-browser', 'sessions'))
    assert.equal(loaded.route, 'pages/dashboard/index')

    await clearSessionState('branch-a', loaded.config)
  } finally {
    await fs.promises.rm(projectDir, { recursive: true, force: true })
    await fs.promises.rm(registryFile, { force: true })
  }
})

test('ensureSessionPorts avoids autoPort used by another project-scoped session', async () => {
  const projectA = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mpb-project-a-'))
  const projectB = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mpb-project-b-'))
  const registryFile = path.join(os.tmpdir(), `mpb-registry-${Date.now()}-ports.json`)

  try {
    await fs.promises.mkdir(path.join(projectA, '.git'), { recursive: true })
    await fs.promises.mkdir(path.join(projectB, '.git'), { recursive: true })

    const existing = createEmptySessionState({
      sessionName: 'other-project',
      config: {
        ...createDefaultConfig('/repo'),
        projectPath: projectB,
        sessionRegistryFile: registryFile,
        autoPort: '9421',
      },
    })
    await saveSessionState(existing)

    const state = {
      name: 'fresh-project',
      config: {
        ...createDefaultConfig('/repo'),
        projectPath: projectA,
        sessionRegistryFile: registryFile,
        devtoolsPort: '',
        autoPort: '',
      },
    }

    const result = await ensureSessionPorts(state, async () => true)
    assert.equal(result.config.autoPort, '9422')
  } finally {
    await fs.promises.rm(projectA, { recursive: true, force: true })
    await fs.promises.rm(projectB, { recursive: true, force: true })
    await fs.promises.rm(registryFile, { force: true })
  }
})

test('acquireSessionLock reclaims stale lock with dead pid metadata', async () => {
  const config = createDefaultConfig('/repo')
  const lockPath = sessionLockPath('stale-demo', config)
  await fs.promises.mkdir(lockPath, { recursive: true })
  await fs.promises.writeFile(path.join(lockPath, 'meta.json'), JSON.stringify({
    pid: 999999,
    startedAt: Date.now() - 60000,
    heartbeatAt: Date.now() - 60000,
  }))

  const lock = await acquireSessionLock('stale-demo', config, { timeoutMs: 500, pollMs: 20 })
  await releaseSessionLock(lock)
})

test('acquireSessionLock times out when active lock heartbeat is fresh', async () => {
  const config = createDefaultConfig('/repo')
  const lockPath = sessionLockPath('busy-demo', config)
  await fs.promises.mkdir(lockPath, { recursive: true })
  await fs.promises.writeFile(path.join(lockPath, 'meta.json'), JSON.stringify({
    pid: process.pid,
    startedAt: Date.now(),
    heartbeatAt: Date.now(),
  }))

  await assert.rejects(
    acquireSessionLock('busy-demo', config, { timeoutMs: 150, pollMs: 20 }),
    /lock timeout/i,
  )

  await fs.promises.rm(lockPath, { recursive: true, force: true })
})

test('acquireSessionLock timeout reports owner pid and command', async () => {
  const config = createDefaultConfig('/repo')
  const lockPath = sessionLockPath('busy-owner-demo', config)
  await fs.promises.mkdir(lockPath, { recursive: true })
  await fs.promises.writeFile(path.join(lockPath, 'meta.json'), JSON.stringify({
    pid: process.pid,
    command: 'open',
    startedAt: Date.now(),
    heartbeatAt: Date.now(),
  }))

  await assert.rejects(
    acquireSessionLock('busy-owner-demo', config, { timeoutMs: 150, pollMs: 20 }),
    /pid=.*command=open/i,
  )

  await fs.promises.rm(lockPath, { recursive: true, force: true })
})
