# meshpoint clients

The `meshpoint` CLI and harness adapters for Meshpoint 1.0. First adapter: Claude Code.

```
meshpoint login --base-url https://api.meshpoint.dev --token <agent token>
meshpoint connect claude-code        # adds hooks to ~/.claude/settings.json
meshpoint status                     # config + project id for the current repo
meshpoint connect claude-code --remove
```

## How the Claude Code adapter works

Every hook runs `meshpoint tap claude-code` with the event payload on stdin.

| hook | what happens |
|---|---|
| SessionStart (startup, resume, clear) | `recall` for the repo's origin remote and branch, teammates fetched in the background (waits up to 1.5s), both rendered into `additionalContext`. |
| UserPromptSubmit | prompt spooled as a `[user]` turn. |
| Stop | the assistant reply since the last prompt spooled as an `[assistant]` turn, with the files it touched through tools as presence paths. |
| PreCompact | spool sent now, with the last 20k chars of transcript as the branch checkpoint. |
| SessionEnd | spool sent now. |

Turns are spooled to `~/.local/state/meshpoint/spool/<session>.jsonl` and sent once the oldest spooled turn is 60s old, so a session costs about one request per minute. A failed send keeps the spool for the next hook. Any failure degrades to an empty hook answer; the mesh never breaks the harness.

The project id is derived from `git remote get-url origin` (`host--owner--repo`); directories without an origin remote are ignored.

## Develop

```
npm install          # links ../meshpoint-sdk
npm run check
npm run build && node dist/bin.js --help
```
