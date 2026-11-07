# meshpoint clients

The `meshpoint` CLI and harness adapters for Meshpoint 1.0. Adapters: Claude Code, Codex.

```
meshpoint login                      # browser login through WorkOS AuthKit; 7-day agent token + refresh session
meshpoint login --base-url https://meshpoint-platform-staging.cmptr.workers.dev   # staging
meshpoint login --base-url <url> --token <agent token>   # pasted dev token instead
meshpoint whoami                     # account, org, role
meshpoint org | org invite <email> [--owner] | org invites | org remove <user> | org sessions | org revoke <id> | org rotate-key | org projects
meshpoint logout
meshpoint connect claude-code --project /abs/path/to/repo   # hooks + skill in <repo>/.claude/ only
meshpoint connect claude-code        # global ~/.claude/ (not until the adapter is signed off)
meshpoint connect codex --project /abs/path/to/repo         # hooks, rules and skill under <repo>/.codex and .agents
meshpoint status                     # config + project id for the current repo
meshpoint items put --item gotcha 'title' 'body'   # write items for the current repo and branch
meshpoint items put < items.json     # same, as a JSON array of {kind, title, body}
meshpoint items retract 3f9c1a2b     # retract by id or unique id prefix
meshpoint connect claude-code --remove
```

## Login

`meshpoint login` listens on a random `127.0.0.1` port, opens `<base>/v1/auth/start?port&nonce&agent` in the browser, and the platform sends the browser back to that port with a one-time grant code after WorkOS AuthKit. The CLI exchanges the code for a 7-day agent token plus a 90-day refresh secret, stored in `~/.config/meshpoint/config.json` (mode 600). Every command refreshes the token when it has under a day left; the hook keeps the stored token if a refresh fails. The agent name defaults to `cli-<hostname>`.

## How the Claude Code adapter works

Every hook runs `meshpoint tap claude-code` with the event payload on stdin.

| hook | what happens |
|---|---|
| SessionStart (startup, resume, clear, compact) | `recall` for the repo's origin remote and branch, teammates fetched in the background (waits up to 1.5s), both rendered into `additionalContext`. |
| UserPromptSubmit | prompt spooled as a `[user]` turn. |
| Stop | the assistant reply since the last prompt spooled as an `[assistant]` turn, with the files it touched through tools as presence paths. When a checkpoint is due, the hook blocks the stop once and asks the agent to run the `meshpoint` skill. |
| PreCompact | spool sent now. |
| SessionEnd | spool sent now. |

Turns are spooled to `~/.local/state/meshpoint/spool/<session>.jsonl` and sent once the oldest spooled turn is 60s old, so a session costs about one request per minute. A failed send keeps the spool for the next hook. Any failure degrades to an empty hook answer; the mesh never breaks the harness.

## Codex

Codex speaks the same hook protocol (event names, payload fields, `hookSpecificOutput.additionalContext`, Stop `decision: block`), so `meshpoint tap codex` is the same tap with a reader for Codex rollouts (`response_item` messages, `apply_patch` paths). `connect codex` writes three things: `.codex/hooks.json` (with `additionalContextLimit` raised from Codex's 2500-char default), `.codex/rules/meshpoint.rules` (prefix rules allowing `meshpoint items put` and `meshpoint items retract`; Codex has no per-skill `allowed-tools`, and "allow" also runs the command outside the sandbox so it can reach the platform), and `.agents/skills/meshpoint/SKILL.md`. Project `.codex/` files load only once the project is trusted in `~/.codex/config.toml` (`[projects."<dir>"] trust_level = "trusted"`); a `-c projects.<dir>.trust_level` command-line override does not load them. Codex asks to review new hooks with `/hooks` before running them; `codex exec` runs hooks too, and `--dangerously-bypass-hook-trust` skips the review for automation. The Codex account's model list may lack the slug pinned in `config.toml` (every turn then fails with `model_not_found`); check `~/.codex/models_cache.json`.

## Checkpoints

Distillation is agent-side: the platform runs no model. `connect` installs the `meshpoint` skill next to the hooks. The skill has the agent write what the session established as items of the fixed kinds (`decision`, `gotcha`, `convention`, `fact`, `status`, `todo`) through `meshpoint items put`, which records the time of the last checkpoint per project branch in `~/.local/state/meshpoint/checkpoints/`. The skill uses the `--item kind title body` argument form: Claude Code's command guard asks for approval on heredocs or JSON with quotes even when the command is allowlisted, while plain single-quoted arguments pass under the skill's `allowed-tools: Bash(meshpoint items put:*)`.

The session-start inject shows each item's id prefix so the skill can retract what the session made obsolete (`meshpoint items retract <prefix>...`, resolved against a fresh recall; ambiguous prefixes are refused).

A checkpoint is due after 20 assistant replies or 60k chars of reply text since the later of the last checkpoint and the last nudge (`~/.local/state/meshpoint/nudges/<session>.json`). An ignored nudge is not repeated until the next pile. The benchmark behind this: one-shot items scored 0.67 resume correctness against 0.60 for a freeform summary and 0.32 for a transcript tail (ceiling 0.82).

The project id is derived from `git remote get-url origin` (`host--owner--repo`); directories without an origin remote are ignored.

## Develop

```
npm install          # links ../meshpoint-sdk
npm run check
npm run build && node dist/bin.js --help
```
