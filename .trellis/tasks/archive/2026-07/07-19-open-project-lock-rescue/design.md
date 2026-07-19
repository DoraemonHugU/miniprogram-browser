# Design

## R2 enrichOpenFailure

```ts
// 禁止: failureContext.code 覆盖 OPEN_TIMEOUT
if (failureContext?.code && !openError.code) {
  openError.code = failureContext.code
}
// OPEN_TIMEOUT 保留；hints 仍可进 diagnostics / hint 补充
```

Also map wait-live message → OPEN_TIMEOUT if within open timeout path (already createOpenTimeoutError for AUTOMATION_CONNECT_TIMEOUT).

## R1 project open lock

`projectOpenLockName(projectPath) => '__open_project__'` under project locks dir (same as session locks via acquireSessionLock with synthetic name).

`handleOpen` when mode will be started (not early attach return):
```
lock = acquireSessionLock('__open_project__', state.config, { command: 'open project' })
try {
  // re-check attach after waiting for lock
  ... existing attach / start ...
} finally { release }
```

Attach-only path can skip or still take lock briefly to serialize with starters.

## R3 rescue after fail

In handleOpen catch before rethrow (or inside loop after openSessionWithDiagnostics fails):
```
if (!options.fresh && openMode==='started') {
  const attach = await resolveAttachableRuntime(state)
  if (attach.mode==='attach' && live) {
    bind port; connect success path; return
  }
}
```

## Tests

- unit: enrichOpenFailure preserves OPEN_TIMEOUT (export or test via open path with mock)
- project lock: optional integration with fake slow open - skip if heavy; at least lock name helper test
