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
} = require('../dist/lib/core.js')

const {
  acquireSessionLock,
  assertProjectPath,
  discoverMiniProgramProjectFromCwd,
  assertBindingConsistency,
  assertNoDevtoolsConflict,
  clearSessionState,
  listSessionStates,
  loadOtherSessionConfigs,
  loadSessionState,
  mergeConfigOverrides,
  prepareSessionStateForSave,
  createDefaultConfig,
  createEmptySessionState,
  assignPorts,
  ensureSessionPorts,
  saveSessionState,
  resolveSessionConfig,
  sessionLockPath,
  sessionLockRoot,
  validateSessionPortConflicts,
  releaseSessionLock,
  runtimeLockName,
  selectAttachableRuntimeSession,
  selectRuntimeLaunchForSession,
  shouldShutdownRuntimeOnClose,
  projectSessionSlug,
  isAutoProjectSessionName,
  pickAutoProjectSessionName,
  nextAutoProjectSessionName,
  listRuntimeLaunches,
  reconcileRuntimeLaunches,
  isEphemeralNoiseSessionName,
} = require('../dist/lib/session-store.js')

test('projectSessionSlug prefers parent when leaf is miniprogram/weapp', () => {
  assert.equal(projectSessionSlug('/mnt/d/xuexi/projects/earlyRiser/apps/miniprogram'), 'earlyriser')
  assert.equal(projectSessionSlug('/work/my-shop/weapp'), 'my-shop')
  assert.equal(projectSessionSlug('/work/CoolApp'), 'coolapp')
  assert.equal(projectSessionSlug('/work/My App!!'), 'my-app')
  assert.equal(projectSessionSlug(''), 'project')
})

test('isAutoProjectSessionName matches slug-xN only', () => {
  assert.equal(isAutoProjectSessionName('earlyriser-x1', 'earlyriser'), true)
  assert.equal(isAutoProjectSessionName('earlyriser-x12', 'earlyriser'), true)
  assert.equal(isAutoProjectSessionName('earlyriser-x0', 'earlyriser'), false)
  assert.equal(isAutoProjectSessionName('earlyriser', 'earlyriser'), false)
  assert.equal(isAutoProjectSessionName('work', 'earlyriser'), false)
  assert.equal(isAutoProjectSessionName('earlyriser-x1', 'other'), false)
})

test('pickAutoProjectSessionName reuses highest existing auto index else x1', () => {
  assert.equal(pickAutoProjectSessionName([], '/work/earlyRiser/apps/miniprogram'), 'earlyriser-x1')
  assert.equal(pickAutoProjectSessionName(['work', 'debug'], '/work/earlyRiser/apps/miniprogram'), 'earlyriser-x1')
  assert.equal(
    pickAutoProjectSessionName(['earlyriser-x1', 'work', 'earlyriser-x3'], '/work/earlyRiser/apps/miniprogram'),
    'earlyriser-x3',
  )
})

test('nextAutoProjectSessionName allocates next free index', () => {
  assert.equal(nextAutoProjectSessionName([], '/work/earlyRiser/apps/miniprogram'), 'earlyriser-x1')
  assert.equal(nextAutoProjectSessionName(['earlyriser-x1'], '/work/earlyRiser/apps/miniprogram'), 'earlyriser-x2')
  assert.equal(
    nextAutoProjectSessionName(['earlyriser-x1', 'earlyriser-x2', 'work'], '/work/earlyRiser/apps/miniprogram'),
    'earlyriser-x3',
  )
})

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

test('formatSnapshotLines appends proportional layout info when enabled', () => {
  const output = formatSnapshotLines([
    {
      ref: '@e1',
      kind: 'view',
      text: '工具箱',
      rectPct: { x: 12.5, y: 20, w: 75, h: 10.5 },
    },
  ], { layout: true })

  assert.deepEqual(output, [
    '@e1 [view] 工具箱 {x:12.5,y:20,w:75,h:10.5}',
  ])
})

test('createDefaultConfig uses apps/miniprogram root projectPath', () => {
  const config = createDefaultConfig('/repo')
  assert.equal(config.projectPath, '')
  assert.equal(config.devtoolsProjectPath, '')
  assert.equal(config.devtoolsProjectMap, '')
  assert.equal(config.trustProject, true)
  assert.equal(config.devtoolsPort, '')
  assert.equal(config.autoPort, '')
  assert.equal(config.legacySessionDir, '')
  assert.equal(config.sessionDir, '')
  assert.equal(typeof config.cliPath, 'string')
})

test('createDefaultConfig allows disabling DevTools trust-project flag from environment', () => {
  const previous = process.env.WECHAT_DEVTOOLS_TRUST_PROJECT
  process.env.WECHAT_DEVTOOLS_TRUST_PROJECT = '0'

  try {
    const config = createDefaultConfig('/repo')
    assert.equal(config.trustProject, false)
  } finally {
    if (previous === undefined) {
      delete process.env.WECHAT_DEVTOOLS_TRUST_PROJECT
    } else {
      process.env.WECHAT_DEVTOOLS_TRUST_PROJECT = previous
    }
  }
})

test('createDefaultConfig reads DevTools project path override from environment', () => {
  const previous = process.env.WECHAT_DEVTOOLS_PROJECT
  process.env.WECHAT_DEVTOOLS_PROJECT = 'P:\\demo\\apps\\miniprogram'

  try {
    const config = createDefaultConfig('/repo')
    assert.equal(config.devtoolsProjectPath, 'P:\\demo\\apps\\miniprogram')
  } finally {
    if (previous === undefined) {
      delete process.env.WECHAT_DEVTOOLS_PROJECT
    } else {
      process.env.WECHAT_DEVTOOLS_PROJECT = previous
    }
  }
})

test('createDefaultConfig reads DevTools project prefix map from environment', () => {
  const previous = process.env.WECHAT_DEVTOOLS_PROJECT_MAP
  process.env.WECHAT_DEVTOOLS_PROJECT_MAP = '/home/wang/xuexi/projects=P:\\projects'

  try {
    const config = createDefaultConfig('/repo')
    assert.equal(config.devtoolsProjectMap, '/home/wang/xuexi/projects=P:\\projects')
  } finally {
    if (previous === undefined) {
      delete process.env.WECHAT_DEVTOOLS_PROJECT_MAP
    } else {
      process.env.WECHAT_DEVTOOLS_PROJECT_MAP = previous
    }
  }
})

test('assertProjectPath requires explicit mini-program root path', () => {
  assert.throws(
    () => assertProjectPath({ projectPath: '' }),
    /--project/i,
  )

  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-browser-project-'))
  const miniprogramRoot = path.join(projectDir, 'miniprogram')
  fs.mkdirSync(miniprogramRoot, { recursive: true })
  fs.writeFileSync(path.join(projectDir, 'project.config.json'), JSON.stringify({ miniprogramRoot: 'miniprogram/' }))
  fs.writeFileSync(path.join(miniprogramRoot, 'app.json'), JSON.stringify({ pages: [] }))

  assert.doesNotThrow(() => {
    assertProjectPath({ projectPath: projectDir })
  })
})

test('discoverMiniProgramProjectFromCwd finds monorepo apps/miniprogram from repo root', async () => {
  const repoDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mpb-monorepo-'))
  const projectDir = path.join(repoDir, 'apps', 'miniprogram')
  const miniprogramRoot = path.join(projectDir, 'dist')

  try {
    await fs.promises.mkdir(miniprogramRoot, { recursive: true })
    await fs.promises.writeFile(path.join(projectDir, 'project.config.json'), JSON.stringify({ miniprogramRoot: 'dist/' }))
    await fs.promises.writeFile(path.join(miniprogramRoot, 'app.json'), JSON.stringify({ pages: ['pages/index/index'] }))

    const found = discoverMiniProgramProjectFromCwd(repoDir)
    assert.equal(found.projectPath, projectDir)
  } finally {
    await fs.promises.rm(repoDir, { recursive: true, force: true })
  }
})

test('discoverMiniProgramProjectFromCwd finds same-git-repo mini program from sibling apps', async () => {
  const repoDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mpb-monorepo-git-'))
  const projectDir = path.join(repoDir, 'apps', 'miniprogram')
  const backendDir = path.join(repoDir, 'apps', 'backend', 'src')
  const miniprogramRoot = path.join(projectDir, 'dist')

  try {
    await fs.promises.mkdir(path.join(repoDir, '.git'), { recursive: true })
    await fs.promises.mkdir(backendDir, { recursive: true })
    await fs.promises.mkdir(miniprogramRoot, { recursive: true })
    await fs.promises.writeFile(path.join(projectDir, 'project.config.json'), JSON.stringify({ miniprogramRoot: 'dist/' }))
    await fs.promises.writeFile(path.join(miniprogramRoot, 'app.json'), JSON.stringify({ pages: ['pages/index/index'] }))

    const found = discoverMiniProgramProjectFromCwd(backendDir)
    assert.equal(found.projectPath, projectDir)
  } finally {
    await fs.promises.rm(repoDir, { recursive: true, force: true })
  }
})

test('discoverMiniProgramProjectFromCwd does not cross out of a git repo to an unrelated parent project', async () => {
  const parentDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mpb-parent-'))
  const parentProjectDir = path.join(parentDir, 'apps', 'miniprogram')
  const repoDir = path.join(parentDir, 'repo')
  const cwd = path.join(repoDir, 'apps', 'backend')

  try {
    await fs.promises.mkdir(path.join(parentProjectDir, 'dist'), { recursive: true })
    await fs.promises.writeFile(path.join(parentProjectDir, 'project.config.json'), JSON.stringify({ miniprogramRoot: 'dist/' }))
    await fs.promises.writeFile(path.join(parentProjectDir, 'dist', 'app.json'), JSON.stringify({ pages: ['pages/index/index'] }))
    await fs.promises.mkdir(path.join(repoDir, '.git'), { recursive: true })
    await fs.promises.mkdir(cwd, { recursive: true })

    const found = discoverMiniProgramProjectFromCwd(cwd)
    assert.equal(found, null)
  } finally {
    await fs.promises.rm(parentDir, { recursive: true, force: true })
  }
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

  // autoPort 不参与 session 身份绑定，override 时允许不同值
  assert.doesNotThrow(() => {
    assertBindingConsistency(
      {
        projectPath: '/worktree-a/apps/miniprogram',
        autoPort: '9422',
      },
      {
        autoPort: '9423',
      },
    )
  })

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

test('loadOtherSessionConfigs skips the current session in its project legacy directory', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mpb-other-sessions-'))
  const registryFile = path.join(os.tmpdir(), `mpb-registry-${Date.now()}-other-sessions.json`)
  try {
    await fs.promises.writeFile(path.join(tempDir, 'demo.json'), JSON.stringify({
      name: 'demo',
      config: {
        projectPath: '/worktree-a/apps/miniprogram',
        sessionDir: tempDir,
        legacySessionDir: tempDir,
        sessionRegistryFile: registryFile,
        autoPort: '9497',
      },
    }))

    const configs = await loadOtherSessionConfigs({
      projectPath: '/worktree-a/apps/miniprogram',
      sessionDir: tempDir,
      legacySessionDir: tempDir,
      sessionRegistryFile: registryFile,
      autoPort: '9497',
    }, 'demo')

    assert.equal(configs.length, 0)
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true })
    await fs.promises.rm(registryFile, { force: true })
  }
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

test('ensureSessionPorts assigns only automation port for a fresh session', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mpb-fresh-'))
  const registryFile = path.join(os.tmpdir(), `mpb-registry-${Date.now()}-fresh.json`)
  try {
    const state = {
      name: 'fresh',
      config: {
        sessionDir: tempDir,
        sessionRegistryFile: registryFile,
        projectPath: '/worktree-a/apps/miniprogram',
        devtoolsPort: '',
        autoPort: '',
      },
    }

    const result = await ensureSessionPorts(state, async () => true)
    assert.equal(result.config.devtoolsPort, '')
    assert.equal(result.config.autoPort, '9515')
    assert.equal(result.portResolution.devtoolsPortAssigned, false)
    assert.equal(result.portResolution.autoPortAssigned, true)
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true })
    await fs.promises.rm(registryFile, { force: true })
  }
})

test('ensureSessionPorts avoids reserved auto ports for fresh session', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mpb-fresh-reserved-'))
  const registryFile = path.join(os.tmpdir(), `mpb-registry-${Date.now()}-reserved.json`)
  try {
    await fs.promises.writeFile(path.join(tempDir, 'other.json'), JSON.stringify({
      config: {
        projectPath: '/worktree-b/apps/miniprogram',
        devtoolsPort: '39085',
        autoPort: '9515',
      },
    }))

    const state = {
      name: 'fresh',
      config: {
        sessionDir: tempDir,
        sessionRegistryFile: registryFile,
        projectPath: '/worktree-a/apps/miniprogram',
        devtoolsPort: '',
        autoPort: '',
      },
    }

    const result = await ensureSessionPorts(state, async () => true)
    assert.equal(result.config.devtoolsPort, '')
    assert.equal(result.config.autoPort, '9516')
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true })
    await fs.promises.rm(registryFile, { force: true })
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
    { devtoolsPort: '39085', autoPort: '9515' },
    { devtoolsPort: '39085', autoPort: '9516' },
  ], async (port) => ![39087, 9517].includes(port))

  assert.equal(assigned.devtoolsPort, '39086')
  assert.equal(assigned.autoPort, '9518')
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
    /Session is busy: demo/i,
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
    assert.equal(root.startsWith(path.join(os.homedir(), '.miniprogram-browser', 'projects')), true)
    assert.equal(root.startsWith(projectDir), false)
  } finally {
    await fs.promises.rm(projectDir, { recursive: true, force: true })
  }
})

test('sessionLockRoot keeps nested miniprogram path state outside project tree', async () => {
  const repoDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mpb-repo-'))
  const projectDir = path.join(repoDir, 'apps', 'miniprogram')
  try {
    await fs.promises.mkdir(path.join(repoDir, '.git'), { recursive: true })
    await fs.promises.mkdir(projectDir, { recursive: true })
    const config = {
      ...createDefaultConfig('/repo'),
      projectPath: projectDir,
    }
    const root = sessionLockRoot(config)
    assert.equal(root.startsWith(path.join(os.homedir(), '.miniprogram-browser', 'projects')), true)
    assert.equal(root.startsWith(repoDir), false)
  } finally {
    await fs.promises.rm(repoDir, { recursive: true, force: true })
  }
})

test('same session blocks concurrent commands in same project with clearer message', async () => {
  const projectDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mpb-lock-project-'))
  const config = {
    ...createDefaultConfig('/repo'),
    projectPath: projectDir,
  }

  const firstLock = await acquireSessionLock('shared-session', config, { command: 'snapshot' })
  try {
    await assert.rejects(
      acquireSessionLock('shared-session', config, { command: 'click', timeoutMs: 20, pollMs: 5 }),
      /Session is busy: shared-session.*同一 session 只允许串行执行/u,
    )
  } finally {
    await releaseSessionLock(firstLock)
    await fs.promises.rm(projectDir, { recursive: true, force: true })
  }
})

test('same session name can lock concurrently across different projects', async () => {
  const projectA = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mpb-lock-a-'))
  const projectB = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mpb-lock-b-'))
  const configA = {
    ...createDefaultConfig('/repo'),
    projectPath: projectA,
  }
  const configB = {
    ...createDefaultConfig('/repo'),
    projectPath: projectB,
  }

  const firstLock = await acquireSessionLock('shared-session', configA, { command: 'snapshot' })
  const secondLock = await acquireSessionLock('shared-session', configB, { command: 'snapshot' })
  try {
    assert.notEqual(firstLock.path, secondLock.path)
  } finally {
    await releaseSessionLock(firstLock)
    await releaseSessionLock(secondLock)
    await fs.promises.rm(projectA, { recursive: true, force: true })
    await fs.promises.rm(projectB, { recursive: true, force: true })
  }
})

test('runtimeLockName serializes sessions attached to the same automation port', () => {
  assert.equal(runtimeLockName({ autoPort: '9527' }), '__runtime_auto_9527')
  assert.equal(runtimeLockName({ autoPort: '' }), '')
})

test('selectAttachableRuntimeSession attaches only when there is one live same-project runtime', () => {
  assert.deepEqual(selectAttachableRuntimeSession([
    { name: 'owner-a', status: 'live', autoPort: '9527' },
  ]), {
    mode: 'attach',
    session: { name: 'owner-a', status: 'live', autoPort: '9527' },
  })
  // 多不同 live port：自动选，不 ambiguous（无 updatedAt 时保持输入顺序首项）
  const multiPort = selectAttachableRuntimeSession([
    { name: 'owner-a', status: 'live', autoPort: '9527', updatedAt: '2026-01-01T00:00:00.000Z' },
    { name: 'owner-b', status: 'live', autoPort: '9530', updatedAt: '2026-06-01T00:00:00.000Z' },
  ])
  assert.equal(multiPort.mode, 'attach')
  assert.equal(multiPort.session.autoPort, '9530')
  assert.equal(multiPort.session.name, 'owner-b')
  assert.deepEqual(selectAttachableRuntimeSession([
    { name: 'stale-a', status: 'stale', autoPort: '9527' },
  ]), {
    mode: 'none',
    sessions: [],
  })
})

test('selectAttachableRuntimeSession treats multiple live rows on same autoPort as one runtime', () => {
  // 多 session 附着同一 automation 端口：不应 SESSION_CONFLICT
  assert.deepEqual(selectAttachableRuntimeSession([
    { name: 'earlyriser-x1', status: 'live', autoPort: '9566' },
    { name: 'work-now', status: 'live', autoPort: '9566' },
  ]), {
    mode: 'attach',
    session: { name: 'earlyriser-x1', status: 'live', autoPort: '9566' },
  })
  assert.deepEqual(selectAttachableRuntimeSession([
    { name: 'earlyriser-x1', status: 'live', autoPort: '9566' },
    { name: 'work-now', status: 'live', autoPort: '9566' },
  ], 'agent-b'), {
    mode: 'attach',
    session: { name: 'earlyriser-x1', status: 'live', autoPort: '9566' },
  })
})

test('isEphemeralNoiseSessionName matches gate/e2e/test prefixes only', () => {
  assert.equal(isEphemeralNoiseSessionName('gate-mrrt6mif'), true)
  assert.equal(isEphemeralNoiseSessionName('e2e-a-abc'), true)
  assert.equal(isEphemeralNoiseSessionName('test-fresh'), true)
  assert.equal(isEphemeralNoiseSessionName('work'), false)
  assert.equal(isEphemeralNoiseSessionName('earlyriser-x1'), false)
  assert.equal(isEphemeralNoiseSessionName('feat-a'), false)
})

test('reconcileRuntimeLaunches marks expired starting rows as stale', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-home-'))
  const previousHome = process.env.HOME
  process.env.HOME = homeDir
  try {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-proj-'))
    fs.writeFileSync(path.join(projectPath, 'project.config.json'), JSON.stringify({ miniprogramRoot: './' }))
    const cfg = mergeConfigOverrides(createDefaultConfig(), { projectPath })
    // record 会刷新 updatedAt；直接写 runtime-launches.json 才能模拟「很久以前的 starting」
    const lockRoot = sessionLockRoot(cfg)
    const registryPath = path.join(path.dirname(lockRoot), 'runtime-launches.json')
    fs.mkdirSync(path.dirname(registryPath), { recursive: true })
    const old = '2020-01-01T00:00:00.000Z'
    const nowIso = new Date().toISOString()
    fs.writeFileSync(registryPath, JSON.stringify({
      launches: [
        {
          id: 'zombie-1',
          sessionName: 'zombie',
          projectPath,
          autoPort: '19590',
          status: 'starting',
          createdAt: old,
          updatedAt: old,
        },
        {
          id: 'fresh-1',
          sessionName: 'fresh',
          projectPath,
          autoPort: '19591',
          status: 'starting',
          createdAt: nowIso,
          updatedAt: nowIso,
        },
      ],
    }, null, 2))
    const result = await reconcileRuntimeLaunches(cfg, { startingMaxAgeMs: 60_000 })
    assert.equal(result.markedStale, 1)
    const after = await listRuntimeLaunches(cfg)
    const byId = Object.fromEntries(after.map((l) => [l.id, l]))
    assert.equal(byId['zombie-1'].status, 'stale')
    assert.equal(byId['fresh-1'].status, 'starting')
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = previousHome
    }
  }
})

test('selectAttachableRuntimeSession prefers matching session name among multiple live runtimes', () => {
  assert.deepEqual(selectAttachableRuntimeSession([
    { name: 'owner-a', status: 'live', autoPort: '9527' },
    { name: 'work', status: 'live', autoPort: '9530' },
  ], 'work'), {
    mode: 'attach',
    session: { name: 'work', status: 'live', autoPort: '9530' },
  })
})

test('selectRuntimeLaunchForSession prefers same sessionName then unique live project runtime', () => {
  const projectA = '/tmp/project-a'
  const projectB = '/tmp/project-b'
  const launches = [
    { id: '1', sessionName: 'debug', projectPath: projectA, status: 'live', autoPort: '9516' },
    { id: '2', sessionName: 'work', projectPath: projectA, status: 'live', autoPort: '9521' },
    { id: '3', sessionName: 'other', projectPath: projectB, status: 'live', autoPort: '9530' },
  ]

  assert.equal(selectRuntimeLaunchForSession(launches, 'work', projectA).autoPort, '9521')
  assert.equal(selectRuntimeLaunchForSession(launches, 'missing', projectB).autoPort, '9530')
  // 同 port 多 launch 视为唯一 runtime
  const shared = [
    { id: 'a', sessionName: 'owner', projectPath: projectA, status: 'live', autoPort: '9566' },
    { id: 'b', sessionName: 'attached', projectPath: projectA, status: 'live', autoPort: '9566' },
  ]
  assert.equal(selectRuntimeLaunchForSession(shared, 'new-session', projectA).autoPort, '9566')
  assert.equal(selectRuntimeLaunchForSession(launches, 'missing', projectA), null)
  assert.equal(selectRuntimeLaunchForSession(launches, 'work', ''), null)
})

test('shouldShutdownRuntimeOnClose keeps attached sessions from closing owner runtime by default', () => {
  assert.equal(shouldShutdownRuntimeOnClose({
    name: 'agent-task',
    runtimeAttached: true,
    runtimeOwnerSession: 'owner',
  }, {}), false)
  assert.equal(shouldShutdownRuntimeOnClose({
    name: 'agent-task',
    runtimeAttached: true,
    runtimeOwnerSession: 'owner',
  }, { runtime: true }), true)
  assert.equal(shouldShutdownRuntimeOnClose({
    name: 'owner',
    runtimeAttached: false,
  }, {}), true)
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
    assert.equal(loaded.config.sessionDir.startsWith(path.join(os.homedir(), '.miniprogram-browser', 'projects')), true)
    assert.equal(loaded.config.sessionDir.startsWith(projectDir), false)
    assert.equal(loaded.route, 'pages/dashboard/index')

    await clearSessionState('branch-a', loaded.config)
  } finally {
    await fs.promises.rm(projectDir, { recursive: true, force: true })
    await fs.promises.rm(registryFile, { force: true })
  }
})

test('saveSessionState stores non-git project sessions outside project tree', async () => {
  const projectDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mpb-project-nongit-'))
  const registryFile = path.join(os.tmpdir(), `mpb-registry-${Date.now()}-nongit.json`)

  try {
    const config = {
      ...createDefaultConfig('/repo'),
      projectPath: projectDir,
      sessionRegistryFile: registryFile,
    }
    const state = createEmptySessionState({ sessionName: 'nongit-project', config })
    state.route = 'pages/dashboard/index'
    state.config.autoPort = '9430'

    await saveSessionState(state)

    assert.equal(state.config.sessionDir.startsWith(projectDir), false)
    assert.equal(fs.existsSync(path.join(projectDir, '.miniprogram-browser')), false)

    const loaded = await loadSessionState('nongit-project', {
      ...createDefaultConfig('/repo'),
      sessionRegistryFile: registryFile,
    })
    assert.equal(loaded.config.projectPath, projectDir)
    assert.equal(loaded.config.sessionDir.startsWith(projectDir), false)

    await clearSessionState('nongit-project', loaded.config)
  } finally {
    await fs.promises.rm(projectDir, { recursive: true, force: true })
    await fs.promises.rm(registryFile, { force: true })
  }
})

test('saveSessionState makes a fresh bound session resolvable before runtime work starts', async () => {
  const projectDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mpb-prebind-project-'))
  const registryFile = path.join(os.tmpdir(), `mpb-registry-${Date.now()}-prebind.json`)

  try {
    const config = {
      ...createDefaultConfig('/repo'),
      projectPath: projectDir,
      sessionRegistryFile: registryFile,
      devtoolsPort: '41080',
      autoPort: '9470',
    }
    const state = createEmptySessionState({ sessionName: 'prebound-session', config })

    await saveSessionState(state)

    const resolved = await resolveSessionConfig('prebound-session', {
      ...createDefaultConfig('/repo'),
      sessionRegistryFile: registryFile,
    })

    assert.equal(resolved.projectPath, projectDir)
    assert.equal(fs.existsSync(path.join(resolved.sessionDir, 'prebound-session.json')), true)
  } finally {
    await fs.promises.rm(projectDir, { recursive: true, force: true })
    await fs.promises.rm(registryFile, { force: true })
  }
})

test('ensureSessionPorts assigns ports without session-file port conflict', async () => {
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
        autoPort: '9515',
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
    assert.equal(result.config.devtoolsPort, '')
    // session 不再固化 autoPort，其他 session 的端口不保留到磁盘竞争
    // fresh-project 分配的第一个可用端口是 9515
    assert.equal(result.config.autoPort, '9515')
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
    /Session is busy: busy-demo/i,
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

const {
  enrichOpenFailure,
  tryHealOpenAfterStartFailure,
  cleanupStartedOpenRuntime,
} = require('../dist/miniprogram-browser.js')

test('enrichOpenFailure does not overwrite OPEN_TIMEOUT with cli-server-start-error hints', async () => {
  const error = {
    message: 'open timed out after 200ms',
    code: 'OPEN_TIMEOUT',
    hint: 'phase=open; timeoutMs=200',
  }
  // state without real logs: buildOpenFailureDiagnostics may return empty
  const state = {
    name: 't',
    config: {
      projectPath: '/tmp/mpb-no-project',
      cliPath: '',
    },
  }
  const enriched = await enrichOpenFailure(error, state, { timeout: 200 })
  assert.equal(enriched.code, 'OPEN_TIMEOUT')
  assert.match(String(enriched.message || ''), /timed out|timeout/i)
})

test('enrichOpenFailure maps wait-live message to OPEN_TIMEOUT when code missing', async () => {
  const error = {
    message: 'DevTools automation 在超时前未在 autoPort=9517 就绪（enable 已返回但 WebSocket 仍不可连）。可加大 --timeout 后重试 open',
  }
  const state = {
    name: 't',
    config: { projectPath: '/tmp/mpb-no-project', cliPath: '' },
  }
  const enriched = await enrichOpenFailure(error, state, { timeout: 5000 })
  assert.equal(enriched.code, 'OPEN_TIMEOUT')
})

test('enrichOpenFailure maps cold-start not-ready message to OPEN_TIMEOUT', async () => {
  const error = {
    message: '冷启动未完成：automation 端口 autoPort=9517 在超时前仍未就绪（devtools auto 已返回，但 WebSocket 尚不可连',
  }
  const state = {
    name: 't',
    config: { projectPath: '/tmp/mpb-no-project', cliPath: '' },
  }
  const enriched = await enrichOpenFailure(error, state, { timeout: 5000 })
  assert.equal(enriched.code, 'OPEN_TIMEOUT')
})

