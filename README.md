# meshpoint clients

The `meshpoint` CLI and harness adapters for Meshpoint 1.0. Adapters: Claude Code, Codex, Cursor, Antigravity, pi, opencode, OpenClaw. Claude Code, Codex, pi, opencode and OpenClaw are verified live against staging; Cursor and Antigravity are ported from their published hook docs and need a live check.

## Install

```
npm i -g @meshpoint/cli@next         # 1.0.0-rc prereleases, until 1.0
npm i -g @meshpoint/cli              # at 1.0
```

```
meshpoint login                      # browser login when one can open; otherwise a device code to approve in the console
meshpoint login --device             # force the device code (cloud agents, SSH); --browser forces the browser
meshpoint login --base-url https://meshpoint-platform-staging.cmptr.workers.dev   # staging
meshpoint login --base-url <url> --token <agent token>   # pasted dev token instead
meshpoint whoami                     # account, org, role
meshpoint doctor                     # login, repo, connected harnesses, last capture, spool; exit 1 when something is wrong
meshpoint org | org invite <email> [--owner] | org invites | org remove <user> | org sessions | org revoke <id> | org rotate-key | org projects
meshpoint logout
meshpoint connect                    # which harnesses this machine has and whether each is connected (--json for agents)
meshpoint connect claude-code        # hooks + skill in ~/.claude/, covers every repo
meshpoint connect codex              # ~/.codex/{hooks.json,rules/meshpoint.rules} + ~/.agents/skills/meshpoint
meshpoint connect cursor             # ~/.cursor/hooks.json + skill
meshpoint connect antigravity        # ~/.gemini/config/hooks.json + skill
meshpoint connect pi [--pi-dir /abs/dir]           # extension stub + skill (default ~/.pi/agent)
meshpoint connect openclaw                         # hook pack via `openclaw plugins install`
meshpoint connect opencode [--config-dir /abs/dir] # plugin link + skill (default ~/.config/opencode)
meshpoint connect <harness> --project /abs/path/to/repo   # per-repo files instead (<repo>/.claude, .codex, .cursor, .agents)
meshpoint connect <harness> --remove [--project <dir>]
meshpoint status                     # config + project id for the current repo
meshpoint items put --item gotcha 'title' 'body'   # write items for the current repo and branch
meshpoint items put < items.json     # same, as a JSON array of {kind, title, body}
meshpoint items retract 3f9c1a2b     # retract by id or unique id prefix
```

`connect <harness>` without `--project` writes to your user config, so every repo you open is on the mesh. `--project <dir>` writes into one repo instead; the files then travel with the repo in git. The meshpoint testbed on the maintainers' machines uses `--project` only.

## Login

`meshpoint login` listens on a random `127.0.0.1` port, opens `<base>/v1/auth/start?port&nonce&agent` in the browser, and the platform sends the browser back to that port with a one-time grant code after WorkOS AuthKit. The CLI exchanges the code for a 7-day agent token plus a 90-day refresh secret, stored in `~/.config/meshpoint/config.json` (mode 600). Every command refreshes the token when it has under a day left; the hook keeps the stored token if a refresh fails. The agent name defaults to `cli-<hostname>`.

Without a browser (no `DISPLAY` or `WAYLAND_DISPLAY` on Linux, or an SSH or CI shell) the CLI uses the device code instead: `POST /v1/auth/device` returns a code and the CLI prints

```
Open https://app.meshpoint.dev/device?code=ABCD-EFGH
or go to https://app.meshpoint.dev/device and enter ABCD-EFGH
Waiting for approval (expires in 15 min)…
```

then polls `POST /v1/auth/device/token` every few seconds (backing off on 429 and network errors) until the user approves the code in the console, which returns the same grant as the browser flow. `--device` and `--browser` force one flow. Denial and expiry end the command with exit 1.

`meshpoint doctor` checks the login file, that the token is accepted (`GET /v1/me`), that the current directory is a repo with an origin remote, that every harness found on the machine is connected (user scope or this repo), the project's last capture, and that the spool directory is writable. `·` lines are informational (no capture yet); only `✗` lines fail the command. `--json` returns `{ok, checks:[{id, status, detail}]}`.

## How the Claude Code adapter works

Every hook runs `meshpoint tap claude-code` with the event payload on stdin.

| hook | what happens |
|---|---|
| SessionStart (startup, resume, clear, compact) | `recall` for the repo's origin remote and branch, teammates fetched in the background (waits up to 1.5s), both rendered into `additionalContext`. |
| UserPromptSubmit | prompt spooled as a `[user]` turn. |
| Stop | the assistant reply since the last prompt spooled as an `[assistant]` turn, with the files it touched through tools as presence paths. When a checkpoint is due, the hook blocks the stop once and asks the agent to run the `meshpoint` skill. |
| PreCompact | spool sent now. |
| SessionEnd | spool sent now. |

Credentials in a prompt or reply (API keys with known prefixes, private key blocks, passwords in URLs, bearer headers, values assigned to names like `token` or `password`) are replaced with `[REDACTED:<kind>]` before the turn is written to the spool, so neither the disk nor the platform holds them; the SDK applies the same masking to items. Turns are spooled to `~/.local/state/meshpoint/spool/<session>.jsonl` and sent once the oldest spooled turn is 60s old, so a session costs about one request per minute. A failed send keeps the spool for the next hook. Any failure degrades to an empty hook answer; the mesh never breaks the harness.

## Codex

Codex speaks the same hook protocol (event names, payload fields, `hookSpecificOutput.additionalContext`, Stop `decision: block`), so `meshpoint tap codex` is the same tap with a reader for Codex rollouts (`response_item` messages, `apply_patch` paths). `connect codex` writes three things: `.codex/hooks.json` (with `additionalContextLimit` raised from Codex's 2500-char default), `.codex/rules/meshpoint.rules` (prefix rules allowing `meshpoint items put` and `meshpoint items retract`; Codex has no per-skill `allowed-tools`, and "allow" also runs the command outside the sandbox so it can reach the platform), and `.agents/skills/meshpoint/SKILL.md`. Project `.codex/` files load only once the project is trusted in `~/.codex/config.toml` (`[projects."<dir>"] trust_level = "trusted"`); a `-c projects.<dir>.trust_level` command-line override does not load them. Codex asks to review new hooks with `/hooks` before running them; `codex exec` runs hooks too, and `--dangerously-bypass-hook-trust` skips the review for automation. The Codex account's model list may lack the slug pinned in `config.toml` (every turn then fails with `model_not_found`); check `~/.codex/models_cache.json`.

## One core, many harnesses

`src/tap.ts` holds one harness session's side of the mesh (`Tap`): recall and presence rendered for injection at start, turns spooled and sent in 60s batches, the checkpoint nudge, one refresh-and-retry after a 401. Hook-style harnesses (Claude Code, Codex, Cursor, Antigravity, OpenClaw) run `meshpoint tap <harness>` once per event with the payload on stdin; in-process harnesses (pi, opencode) call `openTap()` from `src/runtime.ts` and drive the same object directly. Adding a harness means translating its events onto `start / user / assistant / nudge / end`.

## Cursor

`connect cursor` writes `.cursor/hooks.json` entries for `sessionStart`, `beforeSubmitPrompt`, `afterAgentResponse`, `stop`, `preCompact` and `sessionEnd` (command `meshpoint tap cursor`; file format `{"version":1,"hooks":{...}}` per cursor.com/docs/hooks) and the checkpoint skill at `.cursor/skills/meshpoint/SKILL.md`. Cursor reloads `hooks.json` on save. Existing hooks are kept; `--remove` deletes only the meshpoint entries and the skill. Recall and presence arrive as `additional_context` at session start; prompts and replies come from the `beforeSubmitPrompt` and `afterAgentResponse` payloads; a due checkpoint is delivered as a `followup_message` from the `stop` hook, which Cursor submits as the next user message (Cursor caps auto follow-ups at 5 per conversation). Cursor must be allowed to run `meshpoint items put` and `meshpoint items retract` in its shell approval settings. Not yet checked live: the transcript file format (touched paths and the nudge counter depend on it), whether `afterAgentResponse` fires once per turn, and whether the agent picks the skill up from the follow-up on its own. Cursor also loads `.claude/settings.json` hooks, so a repo connected for both would run two taps.

## Antigravity

`connect antigravity` installs one `meshpoint` group in `hooks.json` (workspace `<repo>/.agents/hooks.json`, global `~/.gemini/config/hooks.json`) with handlers running `meshpoint tap antigravity <Event>` for `SessionStart`, `PreInvocation` and `Stop`, and the skill at `.agents/skills/meshpoint/SKILL.md`. Payloads are camelCase and carry no event name, hence the argument. Recall is injected once per conversation as an `injectSteps` system message, keyed by `conversationId` under `~/.local/state/meshpoint/antigravity/`; `PreInvocation` with `invocationNum` 0 spools `lastUserInput` as the user turn (deduplicated, since every model call repeats it); `Stop` spools the reply with the files its tool calls touched, answers `{"decision":"continue","reason":...}` once when a checkpoint is due, and sends the spool at once when `fullyIdle` is true. There is no session-end or compaction event. Not yet checked live: the `transcript.jsonl` line schema (the reader accepts Gemini-shaped and generic records; without per-line timestamps the nudge never fires) and a community report that Stop hooks did not fire in one IDE build.

## pi

`connect pi` writes `<dir>/extensions/meshpoint.js`, a one-line stub importing the built extension by absolute path (pi's loader resolves relative imports from a symlink's own directory, so a symlink does not work), and `<dir>/skills/meshpoint/SKILL.md`. `<dir>` defaults to `$PI_CODING_AGENT_DIR`, then `~/.pi/agent`; pi loads every `.js` in its extensions directory, no settings change needed (`/reload` or restart). Re-run `connect pi` after moving the CLI. Events: `session_start` opens the tap; `before_agent_start` spools the prompt and, once per session, returns a hidden custom message with recall and presence; `turn_end` collects the reply and `tool_call` the `edit`/`write` paths; `agent_before_settle` spools the reply and, when a checkpoint is due, appends the nudge as a custom message with `continue: true` so pi runs one more turn; `session_before_compact` and `session_shutdown` send the spool; `session_compact` re-injects for the next prompt. Verified live: `pi -p` in the testbed against staging captured and showed presence. On this machine `~/.pi/agent/extensions` is a symlink into a dotfiles repo; use `--pi-dir` for tests.

## opencode

`connect opencode` links `<dir>/plugins/meshpoint.js` to the CLI's `dist/opencode/plugin.js` (bun follows the link's real path, so `../runtime.js` and the SDK resolve from the CLI install; re-run after moving it) and writes `<dir>/skills/meshpoint/SKILL.md`; `<dir>` defaults to `~/.config/opencode` honouring `XDG_CONFIG_HOME`. Restart opencode. The plugin file has exactly one export because opencode calls every export as a plugin. Per session it fetches recall and presence once and appends them to the system prompt of every model request (`experimental.chat.system.transform`, waiting up to 4s for the fetch on the first request); `chat.message` spools the prompt, `experimental.text.complete` the reply, `tool.execute.after` the `edit`/`write` paths; `session.idle` flushes a due spool and, when a checkpoint is due, sends a follow-up prompt through `client.session.promptAsync` asking for the `meshpoint` skill. Subagent sessions are ignored. `opencode run` exits about 20ms after `session.idle` without awaiting event handlers, so the last turn of a one-shot run stays spooled until that session continues (`opencode run -c`). Verified live: a headless run in the testbed, continued 60s later, flushed three turns to staging and showed presence.

## OpenClaw

`connect openclaw` writes a dependency-free hook pack (`package.json` with `openclaw.hooks: ["."]`, `HOOK.md`, `handler.js`) and installs it with `openclaw plugins install <dir> --force`; the handler runs `meshpoint tap openclaw` per event, so the Gateway host needs the CLI on PATH and a login. `agent:bootstrap` adds team knowledge, last checkpoint and active teammates to the bootstrap context (a virtual `MESHPOINT.md`, cached per session for 15 minutes because bootstrap fires every run); `message:received` and `message:sent` capture the turns; `/new`, `/reset` and automatic resets send the spool. A chat agent has no repo: set `MESHPOINT_PROJECT=<id>` (`[A-Za-z0-9._-]{1,128}`) and optionally `MESHPOINT_BRANCH` (default `main`) in the Gateway environment; with neither a git workspace nor that variable the hook does nothing. Recall is branch-scoped, so the branch must match where items were written. `--remove` disables the hook and deletes the pack (OpenClaw's `plugins uninstall` does not handle hook packs); restart the Gateway afterwards. Verified live on a Gateway (OpenClaw 2026.9.6) against staging on 2026-11-10: the bootstrap injection reached the model (it answered from a planted item), `message:sent` captured the reply, `/new` flushed the spool, and the console showed the capture and presence. `message:received` fires only for inbound channel messages, not for `openclaw agent -m` runs, so that path still needs a real chat message; `openclaw agent --deliver --channel <ch> --to <id>` is enough to exercise `message:sent`. Gateway logs live in `/tmp/openclaw/openclaw-<date>.log`, not journald. The nudge asks for the `meshpoint` skill, which this adapter does not install (OpenClaw skills live in the workspace).

## Checkpoints

Distillation is agent-side: the platform runs no model. `connect` installs the `meshpoint` skill next to the hooks. The skill has the agent write what the session established as items of the fixed kinds (`decision`, `gotcha`, `convention`, `fact`, `status`, `todo`) through `meshpoint items put`, which records the time of the last checkpoint per project branch in `~/.local/state/meshpoint/checkpoints/`. The skill uses the `--item kind title body` argument form: Claude Code's command guard asks for approval on heredocs or JSON with quotes even when the command is allowlisted, while plain single-quoted arguments pass under the skill's `allowed-tools: Bash(meshpoint items put:*)`.

The session-start inject shows each item's id prefix so the skill can retract what the session made obsolete (`meshpoint items retract <prefix>...`, resolved against a fresh recall; ambiguous prefixes are refused).

A checkpoint is due after 20 assistant replies or 60k chars of reply text since the later of the last checkpoint and the last nudge (`~/.local/state/meshpoint/nudges/<session>.json`). An ignored nudge is not repeated until the next pile. The benchmark behind this: one-shot items scored 0.67 resume correctness against 0.60 for a freeform summary and 0.32 for a transcript tail (ceiling 0.82).

The project id is derived from `git remote get-url origin` (`host--owner--repo`); directories without an origin remote are ignored.

## Develop

The package depends on the published `@meshpoint/sdk`. To work against the sibling checkout instead, link it without touching `package.json`:

```
npm install
npm install ../meshpoint-sdk --no-save   # use the local SDK build (run `npm run build` there first)
npm run check
npm run build && node dist/bin.js --help
```

Publishing (maintainers, after `npm login`): `npm publish` in `../meshpoint-sdk`, then here. `prepublishOnly` runs the checks and the build; `publishConfig` tags prereleases `next`.
