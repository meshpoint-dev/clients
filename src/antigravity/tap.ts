import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { TapDeps } from "../claude-code/tap.js";
import { lastAssistantTurn, lastUserText, type TranscriptEntry } from "../claude-code/transcript.js";
import { Tap } from "../tap.js";
import { parseAntigravityTranscript } from "./transcript.js";

// Antigravity hook payload (antigravity.google/docs/hooks, "Input and output contract"): camelCase,
// the common fields on every event, invocationNum on PreInvocation, executionNum/terminationReason/
// fullyIdle on Stop. The documented payloads carry no event name; connect passes it as the command's
// argument and bin copies it into hookEventName.
export interface AntigravityHookPayload {
  hookEventName?: string;
  conversationId?: string;
  workspacePaths?: string[];
  transcriptPath?: string;
  lastUserInput?: string;
  invocationNum?: number;
  executionNum?: number;
  terminationReason?: string;
  fullyIdle?: boolean;
}

export interface AntigravityTapDeps extends TapDeps {
  // Holds the per-conversation marker files (recall injected, last prompt spooled).
  stateDir: string;
}

// Stop's decision is required; anything but "continue" lets the agent stop.
const ALLOW_STOP = '{"decision":"stop"}';

interface ConversationState {
  recalled?: boolean;
  // Hash of the last prompt spooled; PreInvocation repeats lastUserInput on every model call.
  user?: string;
}

// A conversation outlives executions and hook processes, so what the hook has already done for it
// is kept on disk, like the nudge records in Checkpoints.
class Conversations {
  constructor(private readonly dir: string) {}

  private file(conversation: string): string {
    return path.join(this.dir, "antigravity", `${conversation.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
  }

  read(conversation: string): ConversationState {
    try {
      const parsed = JSON.parse(readFileSync(this.file(conversation), "utf8")) as ConversationState;
      return typeof parsed === "object" && parsed !== null ? parsed : {};
    } catch {
      return {};
    }
  }

  update(conversation: string, patch: ConversationState): void {
    const file = this.file(conversation);
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${JSON.stringify({ ...this.read(conversation), ...patch })}\n`, { mode: 0o600 });
  }
}

// The event, from the command argument bin copied in, else from the fields only that event has.
// PreInvocation and PostInvocation share a payload shape; only PreInvocation is installed.
function eventName(payload: AntigravityHookPayload): string {
  if (payload.hookEventName) return payload.hookEventName;
  if (payload.fullyIdle !== undefined || payload.terminationReason !== undefined) return "Stop";
  if (payload.invocationNum !== undefined) return "PreInvocation";
  if (payload.conversationId !== undefined) return "SessionStart";
  return "";
}

// Context goes in as an injectSteps systemMessage (SessionStart example in the hooks reference);
// ephemeralMessage is transient and the recall must stay in the trajectory.
function inject(text: string): string {
  return JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage: text } }] });
}

// One hook event in, one JSON answer out, the Antigravity way: recall injected once per
// conversation (SessionStart, or the first PreInvocation when SessionStart did not fire), the
// prompt spooled at the first invocation of each execution, the reply at Stop, the spool sent at
// Stop with fullyIdle. The Tap swallows mesh failures; this layer only speaks the hook protocol.
export async function runAntigravityTap(payload: AntigravityHookPayload, deps: AntigravityTapDeps): Promise<string> {
  const event = eventName(payload);
  const empty = event === "Stop" ? ALLOW_STOP : "{}";
  const repo = deps.repo(payload.workspacePaths?.[0] ?? process.cwd());
  if (!repo) return empty;
  const conversation = payload.conversationId ?? "unknown";
  const tap = new Tap({
    config: deps.config,
    repo,
    session: conversation,
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
  const conversations = new Conversations(deps.stateDir);

  const transcript = (): TranscriptEntry[] => {
    if (!payload.transcriptPath) return [];
    try {
      return (deps.parseTranscript ?? parseAntigravityTranscript)(deps.readTranscript(payload.transcriptPath));
    } catch {
      return [];
    }
  };

  const recall = async (): Promise<string> => {
    if (conversations.read(conversation).recalled) return "{}";
    const text = await tap.start();
    conversations.update(conversation, { recalled: true });
    return text ? inject(text) : "{}";
  };

  switch (event) {
    case "SessionStart":
      return recall();
    case "PreInvocation": {
      // invocationNum is 0-indexed: 0 is the first model call of an execution (one user prompt).
      if ((payload.invocationNum ?? 0) !== 0) return "{}";
      const out = await recall();
      const prompt = (payload.lastUserInput ?? lastUserText(transcript()) ?? "").trim();
      const hash = prompt ? createHash("sha256").update(prompt).digest("hex").slice(0, 16) : "";
      if (prompt && conversations.read(conversation).user !== hash) {
        await tap.user(prompt);
        conversations.update(conversation, { user: hash });
      }
      return out;
    }
    case "Stop": {
      const entries = transcript();
      const turn = lastAssistantTurn(entries);
      await tap.assistant(turn?.text ?? "", turn?.paths ?? []);
      // decision "continue" re-enters the loop with reason as a system message. The nudge record
      // keeps the continuation's own Stop from nudging again.
      const reason = tap.nudge(entries);
      // There is no session-end event; fullyIdle means the agent and its background tasks are done.
      if (payload.fullyIdle === true) await tap.end();
      return reason ? JSON.stringify({ decision: "continue", reason }) : ALLOW_STOP;
    }
    default:
      return empty;
  }
}
