# Changelog

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
