# AGENTS.md

This repository builds and ships the `miniprogram-browser` CLI and its Codex skill.

## Development Priorities

- Treat `AGENTS.md` and `skills/miniprogram-browser/SKILL.md` as the primary operational documentation for future agents.
- Keep `README.md` useful for package users, but do not let README maintenance block CLI behavior, tests, or skill guidance.
- Prefer small, explicit abstractions over hidden background behavior.
- Do not use Windows GUI automation, PowerShell window control, OCR, or keyboard driving to solve DevTools runtime issues.

## CLI Design Principles

- `open/connect` must make the DevTools automation path usable by default across macOS, Windows, and WSL.
- Non-business flags such as trust, path conversion, and port selection should be automatic by default.
- Advanced flags are escape hatches, not the normal workflow.
- When automation startup fails, report the real DevTools CLI or runtime issue before generic WebSocket errors.
- Same-project multi-session work is allowed, but each session must have explicit, visible session state and ports.
- Default session views and destructive actions are project-scoped. `--all` is the explicit global escape hatch.

## Project Discovery

- `--project` may be omitted when the current working directory can identify exactly one mini-program project.
- Commands may infer the current mini-program project from the current working directory.
- Discovery should prefer the current mini-program root, then a unique `apps/miniprogram` or `miniprogram` under the same Git worktree.
- Do not cross out of a Git worktree to pick up an unrelated parent project.

## Runtime Attachment

- `session` is the agent work context; runtime is the real DevTools automation endpoint.
- `open/connect` should reuse a unique live same-project runtime by default instead of forcing a fresh DevTools automation endpoint.
- Attached sessions must say which owner runtime they attached to.
- `--fresh` is the explicit escape hatch for trying to start a new runtime.
- Closing an attached session should only unbind that session by default. Closing the owner runtime requires the owner session or an explicit runtime-level close.
- Commands using the same `autoPort` must serialize through a runtime-level lock.

## WSL And Cleanup

- WSL `/home/...` projects may be mirrored into a managed Windows temp directory for DevTools CLI compatibility.
- Mirrors must be marker-backed and under the managed temp root before cleanup.
- Fresh runtime launches should be recorded in project-scoped state before calling DevTools so startup failures can be pruned later.
- Never delete user project directories, Windows drive paths, arbitrary temp folders, or explicit `--devtools-project` paths.
- Do not add background watchers or sync loops unless the user explicitly chooses that design.

## Verification

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
