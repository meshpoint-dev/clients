import { toolFilePaths, type TapDeps } from "../claude-code/tap.js";
import { lastAssistantTurn, type TranscriptEntry } from "../claude-code/transcript.js";
import { NUDGE_PREFIX, Tap } from "../tap.js";
import { parseCursorTranscript } from "./transcript.js";

// Cursor's hook dialect, per https://cursor.com/docs/hooks ("Reference"): camelCase event names,
// a snake_case payload that carries conversation_id, workspace_roots and transcript_path on every
// event, and one output schema per event.
export interface CursorHookPayload {
  hook_event_name?: string;
  conversation_id?: string;
  // sessionStart and sessionEnd repeat conversation_id under this name.
  session_id?: string;
  workspace_roots?: string[];
  transcript_path?: string | null;
  // beforeSubmitPrompt
  prompt?: string;
  // afterAgentResponse: the assistant's final text.
  text?: string;
  // stop: "completed" | "aborted" | "error", and how many follow-ups this conversation has had.
  status?: string;
  loop_count?: number;
  // postToolUse: the tool and its input; file tools carry file_path.
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  file_path?: string;
}

const CONTINUE = '{"continue":true}';

// One Cursor hook event in, one JSON answer out. Same deps as the Claude Code wrapper so bin.ts
// builds one deps object; parseTranscript defaults to the Cursor reader. The Tap swallows mesh
// failures; this layer only speaks the protocol.
export async function runCursorTap(payload: CursorHookPayload, deps: TapDeps): Promise<string> {
  const event = payload.hook_event_name ?? "";
  const empty = event === "beforeSubmitPrompt" ? CONTINUE : "{}";
  // Project hooks run from the project root, user hooks from ~/.cursor; workspace_roots is right in both.
  const repo = deps.repo(payload.workspace_roots?.[0] ?? process.cwd());
  if (!repo) return empty;
  const tap = new Tap({
    config: deps.config,
    repo,
    session: payload.conversation_id ?? payload.session_id ?? "unknown",
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
      return (deps.parseTranscript ?? parseCursorTranscript)(deps.readTranscript(payload.transcript_path));
    } catch {
      return [];
    }
  };

  switch (event) {
    case "sessionStart": {
      const text = await tap.start();
      return text ? JSON.stringify({ additional_context: text }) : "{}";
    }
    case "beforeSubmitPrompt": {
      // A stop hook's followup_message comes back through here as a user prompt; keep ours out of the capture.
      const prompt = payload.prompt ?? "";
      await tap.user(prompt.startsWith(NUDGE_PREFIX) ? "" : prompt);
      return CONTINUE;
    }
    case "postToolUse": {
      // After a file edit: the only Cursor event around a tool call that takes additional_context.
      const files = payload.file_path ? [payload.file_path] : toolFilePaths(payload.tool_input);
      const notices: string[] = [];
      for (const file of files) {
        const text = await tap.edit(file);
        if (text) notices.push(text);
      }
      return notices.length > 0 ? JSON.stringify({ additional_context: notices.join("\n\n") }) : "{}";
    }
    case "afterAgentResponse": {
      // The documented text field is the reply; the transcript, when readable, adds the touched paths.
      await tap.assistant(payload.text ?? "", lastAssistantTurn(transcript())?.paths ?? []);
      return "{}";
    }
    case "stop": {
      // A non-empty followup_message is auto-submitted as the next user message, which keeps the
      // agent going so it writes its items now. Recording the nudge already stops it repeating;
      // Cursor's own loop_limit (default 5 per script) caps follow-ups per conversation on top.
      if (payload.status !== undefined && payload.status !== "completed") return "{}";
      const reason = tap.nudge(transcript());
      return reason ? JSON.stringify({ followup_message: reason }) : "{}";
    }
    case "preCompact":
    case "sessionEnd":
      await tap.end();
      return "{}";
    default:
      return empty;
  }
}
