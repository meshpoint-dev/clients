import type { Checkpoints } from "../checkpoints.js";
import type { Config, RepoContext } from "../config.js";
import type { Spool } from "../spool.js";
import { Tap } from "../tap.js";
import { lastAssistantTurn, parseTranscript as parseClaudeCodeTranscript, type TranscriptEntry } from "./transcript.js";

export { renderInject } from "../tap.js";

export interface HookPayload {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  prompt?: string;
  source?: string;
  trigger?: string;
  reason?: string;
  stop_hook_active?: boolean;
}

export interface TapDeps {
  config: Config;
  repo: (cwd: string) => RepoContext | null;
  readTranscript: (file: string) => string;
  spool: Spool;
  checkpoints: Checkpoints;
  // Transcript reader for the harness; defaults to Claude Code's.
  parseTranscript?: (jsonl: string) => TranscriptEntry[];
  now?: () => number;
  fetch?: typeof fetch;
  presenceWaitMs?: number;
  refresh?: () => Promise<Config | null>;
}

// One hook event in, one JSON answer out. Claude Code and Codex share the hook protocol (event
// names, payload fields, additionalContext, Stop block), so one wrapper serves both. The Tap
// swallows mesh failures; this layer only speaks the hook protocol.
export async function runClaudeCodeTap(payload: HookPayload, deps: TapDeps): Promise<string> {
  const event = payload.hook_event_name ?? "";
  const empty = event === "Stop" ? '{"decision":"continue"}' : "{}";
  const repo = deps.repo(payload.cwd ?? process.cwd());
  if (!repo) return empty;
  const tap = new Tap({
    config: deps.config,
    repo,
    session: payload.session_id ?? "unknown",
    spool: deps.spool,
    checkpoints: deps.checkpoints,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.presenceWaitMs !== undefined ? { presenceWaitMs: deps.presenceWaitMs } : {}),
    ...(deps.refresh ? { refresh: deps.refresh } : {}),
  });

  const transcript = (): TranscriptEntry[] => {
    if (!payload.transcript_path) return [];
    try {
      return (deps.parseTranscript ?? parseClaudeCodeTranscript)(deps.readTranscript(payload.transcript_path));
    } catch {
      return [];
    }
  };

  switch (event) {
    case "SessionStart": {
      const text = await tap.start();
      return text ? JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } }) : "{}";
    }
    case "UserPromptSubmit":
      await tap.user(payload.prompt ?? "");
      return "{}";
    case "Stop": {
      const entries = transcript();
      const turn = lastAssistantTurn(entries);
      await tap.assistant(turn?.text ?? "", turn?.paths ?? []);
      // A due checkpoint keeps the turn going so the agent writes its items now. stop_hook_active
      // means this Stop is already a continuation; never nudge twice in a row.
      const reason = payload.stop_hook_active ? null : tap.nudge(entries);
      return reason ? JSON.stringify({ decision: "block", reason }) : '{"decision":"continue"}';
    }
    case "PreCompact":
    case "SessionEnd":
      await tap.end();
      return "{}";
    default:
      return empty;
  }
}
