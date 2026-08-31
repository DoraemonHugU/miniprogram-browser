# AGENTS.md

This repository builds and ships the `miniprogram-browser` CLI and its Codex skill.

## Development Priorities

- Treat `AGENTS.md` and `skills/miniprogram-browser/SKILL.md` as the primary operational documentation for future agents.
- Product contracts (CLI stable surface, `@e` lifecycle): `docs/spec/cli/product-contracts.md` — keep skill in sync when those rules change.
- Keep `README.md` useful for package users, but do not let README maintenance block CLI behavior, tests, or skill guidance.
- Prefer small, explicit abstractions over hidden background behavior.
- Do not use Windows GUI automation, PowerShell window control, OCR, or keyboard driving to solve DevTools runtime issues.

## CLI Design Principles

- Product rule: the tool absorbs dirty work. Users should reach the goal by the most direct action; trust, path conversion, port allocation, and runtime reuse are internal by default.
- `open/connect` must make the DevTools automation path usable by default across macOS, Windows, and WSL.
- Ideal success path: open a project directory and land on a connected DevTools automation session without asking users to manage internal machinery.
- Non-business flags such as trust, path conversion, and port selection should be automatic by default.
- Advanced flags are escape hatches, not the normal workflow.
- On success, still surface necessary operational facts (including `autoPort`, mode, path, project). These are observability fields, not configuration burden.
- When automation startup fails, explain the situation clearly and keep the real underlying DevTools CLI / runtime error visible. Do not replace root causes with generic project-wrapper exceptions.
- Automatic diagnostics must not read shared DevTools logs or other projects' session files. `devtools logs` explicitly reads shared logs and is not project-isolated; never use it to collect production information for public examples or test artifacts.
- Failures the tool cannot fix (login/token expiry, missing AppID, bad CLI path) need a clear human explanation plus the original error signal. Stable `code` / `next action` fields are optional helpers, not required product shape.
- Same-project multi-session work is allowed, but each session must have explicit, visible session state and ports.
- `session list` must surface usable autoPort/status for attached sessions (project live runtime), not only owner launch rows.
- `open/connect --session <name>` 成功后会记录项目活动 session；省略 `--session` 时优先沿用活动 session，`MINIPROGRAM_BROWSER_SESSION` 可作为显式 Agent 默认值。
- `doctor` is live-first: probe existing automation when possible; do not always re-run enableAutomation.
- Default session views and destructive actions are project-scoped. `--all` is the explicit global escape hatch.

## Project Discovery

- `--project` may be omitted when the current working directory can identify exactly one mini-program project.
- Commands may infer the current mini-program project from the current working directory.
- Discovery should prefer the current mini-program root, then a unique `apps/miniprogram` or `miniprogram` under the same Git worktree.
- Do not cross out of a Git worktree to pick up an unrelated parent project.

## Runtime Attachment

- `session` is the agent work context; runtime is the real DevTools automation endpoint.
- `open/connect` should reuse a unique live same-project runtime by default instead of forcing a fresh DevTools automation endpoint.
- Multiple session/launch rows sharing the **same autoPort** count as one runtime.
- autoPort is owned by the CLI (allocate + reserve + attach). Users do not choose ports. Multiple different live ports are a target ambiguity: when no explicit session matches, show the candidate sessions and require `--session`; never silently choose the newest.
- Attached sessions must say which owner runtime they attached to.
- `--fresh` is the explicit escape hatch for trying to start a new runtime.
- Closing an attached session should only unbind that session by default. Closing the owner runtime requires the owner session or an explicit runtime-level close.
- Commands using the same `autoPort` must serialize through a runtime-level lock.

## WSL And Cleanup

- Prefer WSL projects under `/mnt/<drive>/...` so DevTools receives a normal Windows drive path.
- Linux-home `/home/...` paths are not managed-mirrored anymore; use a Windows-drive project, `--devtools-project`, or `--project-map` when DevTools cannot consume the path directly.
- Fresh runtime launches should be recorded in project-scoped state before calling DevTools so startup failures can be pruned later.
- Never delete user project directories, Windows drive paths, arbitrary temp folders, or explicit `--devtools-project` paths.
- Do not add background watchers or sync loops unless the user explicitly chooses that design.

## Verification

- CLI source lives in `src/` (TypeScript); `dist/` is generated and is the executable entry point. After source edits, run `npm run build` before invoking the CLI or tests; do not rely on stale build output.
- `npm test` runs the build, Node tests, and image-processing Python tests; the latter require a working `python` command. Use `npm run lint` and `npm run typecheck:strict` for static checks.
- Real DevTools open gate (optional, not in default `npm test`):
  ```bash
  export WECHAT_DEVTOOLS_CLI=/path/to/cli
  export MINIPROGRAM_BROWSER_GATE_PROJECT=/mnt/d/path/to/miniprogram
  npm run test:real-open-gate   # exit 0 pass, 1 fail, 2 skip (no env)
  npm run test:l0-e2e           # broader L0 journey + real interactions
  ```
  Expect: open→path→snapshot (gate); L0 e2e adds session reuse, goto, real click/swipe/scroll/longpress/back, transient-state capture, and logs. Real gates reject projects whose AppID is not `touristappid`, and clean their sessions on exit.

- Add or update tests before behavior changes when feasible.
- At minimum run `npm run build` and the relevant `node --test ...` subset after edits.
- Before claiming completion, run the full feasible verification set and report any skipped real-DevTools smoke separately.

## Repository Specs

- This repository maintains its own specifications under `docs/spec/`; start with `docs/spec/index.md` and read only the contracts relevant to the change.
- `AGENTS.md` is the shared agent instruction source. `CLAUDE.md` imports it instead of maintaining a second set of rules.
- Specs describe current behavior, boundaries, failure cases, and verification. Keep exploratory ideas in `ROADMAP.md`, not in established contracts.
- When behavior changes, update the affected spec, tests, and user-facing skill together. Investigate disagreements with current code rather than silently following an outdated spec.
- Work directly from the user's request with a brief plan when needed. There is no mandatory task-creation, activation, archival, journal, or hook-driven workflow.
