import type { Checkpoints } from "../checkpoints.js";
import { patchFilePaths } from "../codex/transcript.js";
import type { Config, RepoContext } from "../config.js";
import type { SessionCache } from "../context.js";
import type { Spool } from "../spool.js";
import { Tap, type LocalChecks } from "../tap.js";
import type { Touched } from "../touched.js";
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
  // PreToolUse and PostToolUse.
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

const TOOL_PATH_KEYS = ["file_path", "path", "notebook_path"] as const;
// One apply_patch can touch several files; the notice covers the first few.
const PATCH_FILES_MAX = 3;

// The files an editing tool call is about: Claude Code names one in tool_input; Codex's
// apply_patch carries the whole patch in tool_input.command.
export function toolFilePaths(input: Record<string, unknown> | undefined): string[] {
  for (const key of TOOL_PATH_KEYS) {
    const v = input?.[key];
    if (typeof v === "string" && v) return [v];
  }
  const command = input?.command;
  return typeof command === "string" ? patchFilePaths(command).slice(0, PATCH_FILES_MAX) : [];
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
  touched?: Touched;
  cache?: SessionCache;
  // Built per repository root: verification and instruction-file lookup need the checkout.
  local?: (root: string) => LocalChecks;
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
    ...(deps.touched ? { touched: deps.touched } : {}),
    ...(deps.cache ? { cache: deps.cache } : {}),
    ...(deps.local ? { local: deps.local(repo.root) } : {}),
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
    case "PreToolUse":
    case "PostToolUse": {
      const notices: string[] = [];
      for (const file of toolFilePaths(payload.tool_input)) {
        const text = await tap.edit(file);
        if (text) notices.push(text);
      }
      return notices.length > 0 ? JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: notices.join("\n\n") } }) : "{}";
    }
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
