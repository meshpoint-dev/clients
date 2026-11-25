# Changelog

## 1.10.0

The distillation prompts and parsers behind `import sessions` now come from `@meshpoint/sdk` 1.4.0, shared with the platform's console Distill action, so both paths send the model the same prompt for the same transcript. No change in behaviour.

## 1.9.0

`meshpoint context write [--file <path>]`: the session-start context (team knowledge with item ids, verification marks against this checkout, the stale list, teammates active) as a marked block in `AGENTS.md`, for a checkout without hooks: CI jobs and cloud agents logged in with a service account token. The block sits beside the conventions block from `export agents` and is replaced in place on rerun. `whoami` on a service account token shows the account under `service`.

## 1.8.0

`meshpoint mcp [--cwd <dir>]`: a stdio MCP server for agents without a hook (VS Code with Copilot, Claude Desktop, Zed, cloud agents). Tools: `meshpoint_recall` (the session-start block), `meshpoint_file_context` (the pre-edit notice, every call), `meshpoint_items_put`, `meshpoint_items_retract`, `meshpoint_items_confirm`. The server's instructions carry the checkpoint rules. `meshpoint connect mcp --project <repo>` writes the entry into `<repo>/.mcp.json` (Claude Code project scope, VS Code with Copilot); without `--project` it prints the entry and the user-level file per client. No capture, presence or nudge on this path.

## 1.7.0

`meshpoint export agents [--file <path>] [--check]` writes the branch's conventions into `AGENTS.md` as a marked block, one line per convention with its item id, for agents that read the file without a hook and for teammates without Meshpoint. Only the block is touched; a rerun refreshes it in place and `--check` exits 1 when it is out of date. The session-start context leaves out conventions the harness already reads from the file (Codex, Cursor, pi, opencode read `AGENTS.md`; Claude Code through `CLAUDE.md` or its `@AGENTS.md` import) and says how many are there. `connect` points at the command when the repository has no block yet.

## 1.6.0

`import sessions --help` prints the flags and runs nothing. Discovery reads transcript headers only, so a run starts within seconds. Per-session results are cached under `~/.local/state/meshpoint/import/cache/` (`--fresh` ignores them). Every proposed item carries a verbatim transcript quote as evidence, checked against the transcript; items without one are dropped. Items from a branch that is gone or already merged land on the default branch. After `connect`, the CLI says how many past sessions it found for the repository and the command to import them.

## 1.5.0

`import sessions --propose` sends the proposal to the platform and prints a console link; the review page shows every item per branch with checkboxes and editable fields, and the author or an admin applies it there. Nothing is written until then.

## 1.4.2

`import sessions --apply --from <items.json>` uploads a reviewed proposal file exactly as edited (delete entries, fix titles or bodies, change kinds; refs are re-read from the text). The dry run now prints the review path and that command. Saved proposals carry each item's session date and source harnesses.

## 1.4.1

Imports never write `status` items (a new status would supersede the branch's current one), and imported items carry the time of the newest session that produced them, so ranking and decay see their real age.

## 1.4.0

`meshpoint import sessions`: backfill a repository's memory from the harness transcripts already on the machine. Reads Claude Code, Codex, pi, opencode and Antigravity stores (Cursor best effort; OpenClaw keeps none), maps each session to a project by its recorded directory's origin remote, distills every session into items with your own agent CLI (`claude -p` or `codex exec`, no platform model), merges per branch (keys for conventions, recurring gotchas marked, supersedes against live items), drops items naming files the checkout no longer has, and writes a proposal plus a report under `~/.local/state/meshpoint/import/`. Dry run by default; `--apply` uploads with `import:<harness>` provenance; `--with-turns` also uploads the last 30 days of turns as sessions. Defaults to the current repository and 90 days; `--since` beyond that or `--all-repos` asks first (`--yes` skips).

## 1.3.0

Every capture carries the harness session id, so the console's Sessions view groups turns into exact runs. Depends on `@meshpoint/sdk` 1.3.0.

## 1.2.0

- `items put` takes `--supersedes <id>[,<id>]` and `--key <slot>` after an `--item` (and `supersedes`, `key` in the JSON form). Supersedes prefixes resolve like retract. The replaced item leaves recall with a link to its successor; a `status` item always replaces the branch's previous status.
- `status` and `todo` items unconfirmed for 30 days are left out of the inject and the edit notice, even when a cached blob still carries them.
- The skill explains supersedes, keys and decay. Depends on `@meshpoint/sdk` 1.2.0.

## 1.1.0

Memory follows the code.

- `items put` attaches each item's refs (repo-relative paths named in its text that exist in the checkout), the paths edited on the branch since the last checkpoint, and HEAD. Path-like tokens that resolve to nothing print `ref not found: <path>`.
- Session start verifies the branch's items against the checkout, with no model: every ref present and untouched since the item is verified (and counts as a confirmation), changed since is suspect (marked `?` in the inject), gone is stale (listed under "Possibly stale" for the agent to retract or rewrite). A checkout older than the item's commit skips it. Results go to the platform; three users seeing an item stale drop it from recall.
- Edit hook: before a file is edited (Claude Code `PreToolUse`, Codex `PreToolUse` on `apply_patch`), or right after (opencode `tool.execute.after`, pi `tool_result`, Cursor `postToolUse`), the agent gets the file's gotcha, decision and convention items and any teammate who touched the file in the last five minutes on any branch. One notice per file per session.
- Import nudge: the first session on a branch with no items and committed instruction files (CLAUDE.md, AGENTS.md, Cursor rules, Copilot instructions, Kiro steering) is asked once to run the new `meshpoint-import` skill, installed by every `connect`.
- `items confirm <id>...`.
- Depends on `@meshpoint/sdk` 1.1.0.

## 1.0.0

First stable release of the `meshpoint` CLI: login, connect, tap for Claude Code, Codex, Cursor, Antigravity, OpenClaw, pi and opencode, items, recall, device-code auth. Same behavior as 1.0.0-rc.4; depends on `@meshpoint/sdk` 1.0.0.
