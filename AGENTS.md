# AGENTS.md

This repository builds and ships the `miniprogram-browser` CLI and its Codex skill.

## Development Priorities

- Treat `AGENTS.md` and `skills/miniprogram-browser/SKILL.md` as the primary operational documentation for future agents.
- Product contracts (CLI stable surface, `@e` lifecycle): `.trellis/spec/cli/product-contracts.md` — keep skill in sync when those rules change.
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
- Failures the tool cannot fix (login/token expiry, missing AppID, bad CLI path) need a clear human explanation plus the original error signal. Stable `code` / `next action` fields are optional helpers, not required product shape.
- Same-project multi-session work is allowed, but each session must have explicit, visible session state and ports.
- `session list` must surface usable autoPort/status for attached sessions (project live runtime), not only owner launch rows.
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
- autoPort is owned by the CLI (allocate + reserve + attach). Multiple different live ports are never a user decision: auto-attach to the newest; never surface SESSION_CONFLICT / ambiguous for port choice.
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

- Real DevTools open gate (optional, not in default `npm test`):
  ```bash
  export WECHAT_DEVTOOLS_CLI=/path/to/cli.js
  export MINIPROGRAM_BROWSER_GATE_PROJECT=/mnt/d/path/to/miniprogram
  npm run test:real-open-gate   # exit 0 pass, 1 fail, 2 skip (no env)
  npm run test:l0-e2e           # broader L0 journey + branches (goto/session/click soft)
  ```
  Expect: open→path→snapshot (gate); L0 e2e adds second session, goto, snapshot, soft click, logs.

- Add or update tests before behavior changes when feasible.
- At minimum run `npm run build` and the relevant `node --test ...` subset after edits.
- Before claiming completion, run the full feasible verification set and report any skipped real-DevTools smoke separately.
<!-- TRELLIS:START -->
# Trellis Instructions

These instructions are for AI assistants working in this project.

This project is managed by Trellis. The working knowledge you need lives under `.trellis/`:

- `.trellis/workflow.md` — development phases, when to create tasks, skill routing
- `.trellis/spec/` — package- and layer-scoped coding guidelines (read before writing code in a given layer)
- `.trellis/workspace/` — per-developer journals and session traces
- `.trellis/tasks/` — active and archived tasks (PRDs, research, jsonl context)

If a Trellis command is available on your platform (e.g. `/trellis:finish-work`, `/trellis:continue`), prefer it over manual steps. Not every platform exposes every command.

If you're using Codex or another agent-capable tool, additional project-scoped helpers may live in:
- `.agents/skills/` — reusable Trellis skills
- `.codex/agents/` — optional custom subagents

Managed by Trellis. Edits outside this block are preserved; edits inside may be overwritten by a future `trellis update`.

<!-- TRELLIS:END -->
