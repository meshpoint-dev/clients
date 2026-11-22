# Changelog

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
