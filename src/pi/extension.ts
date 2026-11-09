import path from "node:path";
import type { TranscriptEntry } from "../claude-code/transcript.js";
import { openTap } from "../runtime.js";
import type { Tap } from "../tap.js";

// The slice of pi 1.4's extension API this file uses, declared structurally so the package needs
// no pi dependency. Shapes follow pi's dist/core/extensions/types.d.ts.
export interface PiContent {
  type: string;
  text?: string;
}

export interface PiMessage {
  role: string;
  content: string | PiContent[];
  // Epoch ms.
  timestamp?: number;
}

export interface PiEntry {
  type: string;
  message?: PiMessage;
}

export interface PiContext {
  cwd: string;
  sessionManager: { getSessionId(): string; getBranch(): PiEntry[] };
}

export interface PiCustomMessage {
  customType: string;
  content: string;
  display: boolean;
}

export interface PiBoundaryResult {
  entries?: ({ type: "custom_message" } & PiCustomMessage)[];
  continue?: boolean;
}

export interface PiEvents {
  session_start: [{ reason: string }, void];
  before_agent_start: [{ messageType: "user"; prompt: string } | { messageType: "custom" }, { message: PiCustomMessage } | undefined];
  turn_end: [{ message: PiMessage }, undefined];
  tool_call: [{ toolName: string; input: Record<string, unknown> }, undefined];
  agent_before_settle: [{ outcome: "completed" | "aborted" | "error" }, PiBoundaryResult | undefined];
  session_before_compact: [{ reason: string }, undefined];
  session_compact: [{ reason: string }, void];
  session_shutdown: [{ reason: string }, void];
}

export interface PiApi {
  on<E extends keyof PiEvents>(event: E, handler: (event: PiEvents[E][0], ctx: PiContext) => PiEvents[E][1] | Promise<PiEvents[E][1]>): unknown;
}

export type TapLike = Pick<Tap, "start" | "user" | "assistant" | "nudge" | "end">;

export interface PiExtensionDeps {
  open?: (session: string, cwd: string) => Promise<TapLike | null>;
  now?: () => number;
}

export const INJECT_TYPE = "meshpoint";
export const NUDGE_TYPE = "meshpoint-nudge";
const EDITING_TOOLS = new Set(["edit", "write"]);

export function messageText(content: string | PiContent[]): string {
  if (typeof content === "string") return content.trim();
  return content
    .map((c) => (c.type === "text" && typeof c.text === "string" ? c.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

// Assistant replies already on the session branch, so a resumed session counts toward its
// checkpoint from where it left off.
export function assistantEntries(branch: PiEntry[]): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (const e of branch) {
    if (e.type !== "message" || e.message?.role !== "assistant") continue;
    const text = messageText(e.message.content);
    if (text) out.push({ role: "assistant", text, paths: [], at: e.message.timestamp ?? 0 });
  }
  return out;
}

// Event mapping: session_start opens the Tap and starts recall in the background; the first
// user run injects it as a hidden custom message and records the prompt; turn_end and tool_call
// collect the run's reply text and edited files; agent_before_settle spools the reply and, when a
// checkpoint is due, appends the nudge and asks for one more model request; compaction and
// shutdown flush. Every handler swallows failures: the mesh must never break pi.
export function meshpointExtension(pi: PiApi, deps: PiExtensionDeps = {}): void {
  const open = deps.open ?? openTap;
  const now = deps.now ?? Date.now;
  let tap: TapLike | null = null;
  let inject: Promise<string> | null = null;
  let entries: TranscriptEntry[] = [];
  let texts: string[] = [];
  let paths: string[] = [];

  const quiet = async <T>(work: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await work();
    } catch {
      return undefined;
    }
  };

  pi.on("session_start", (_event, ctx) =>
    quiet(async () => {
      tap = await open(ctx.sessionManager.getSessionId(), ctx.cwd);
      if (!tap) return;
      entries = assistantEntries(ctx.sessionManager.getBranch());
      texts = [];
      paths = [];
      inject = tap.start();
    }),
  );

  pi.on("before_agent_start", (event) =>
    quiet(async () => {
      if (!tap || event.messageType !== "user") return undefined;
      await tap.user(event.prompt);
      if (!inject) return undefined;
      const text = await inject;
      inject = null;
      return text ? { message: { customType: INJECT_TYPE, content: text, display: false } } : undefined;
    }),
  );

  pi.on("turn_end", (event) => {
    if (!tap || event.message.role !== "assistant") return undefined;
    const text = messageText(event.message.content);
    if (text) texts.push(text);
    return undefined;
  });

  pi.on("tool_call", (event, ctx) => {
    const p = event.input.path;
    if (tap && EDITING_TOOLS.has(event.toolName) && typeof p === "string" && p) paths.push(path.resolve(ctx.cwd, p));
    return undefined;
  });

  pi.on("agent_before_settle", (event) =>
    quiet(async () => {
      if (!tap) return undefined;
      const text = texts.join("\n\n");
      const touched = [...new Set(paths)];
      texts = [];
      paths = [];
      if (!text && touched.length === 0) return undefined;
      await tap.assistant(text, touched);
      entries.push({ role: "assistant", text, paths: touched, at: now() });
      if (event.outcome !== "completed") return undefined;
      const nudge = tap.nudge(entries);
      if (!nudge) return undefined;
      return { entries: [{ type: "custom_message", customType: NUDGE_TYPE, content: nudge, display: true }], continue: true };
    }),
  );

  pi.on("session_before_compact", () =>
    quiet(async () => {
      await tap?.end();
      return undefined;
    }),
  );

  // The injected recall may have been summarized away; fetch it again for the next prompt.
  pi.on("session_compact", () => {
    if (tap) inject = tap.start();
  });

  pi.on("session_shutdown", () =>
    quiet(async () => {
      const closing = tap;
      tap = null;
      inject = null;
      await closing?.end();
    }),
  );
}

export default function (pi: PiApi): void {
  meshpointExtension(pi);
}
