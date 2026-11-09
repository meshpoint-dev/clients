import type { TranscriptEntry } from "../claude-code/transcript.js";
import type { Tap } from "../tap.js";

// The slice of the opencode plugin API (@opencode-ai/plugin 1.x) this adapter touches, declared
// structurally so the CLI carries no opencode dependency.
export interface OpencodePart {
  type: string;
  text?: string;
  synthetic?: boolean;
}

export interface OpencodeModel {
  providerID: string;
  modelID: string;
}

export interface OpencodeClient {
  session: {
    promptAsync(opts: {
      path: { id: string };
      body: { agent?: string; model?: OpencodeModel; parts: Array<{ type: "text"; text: string }> };
    }): Promise<unknown>;
  };
}

export interface OpencodeEvent {
  type: string;
  properties?: unknown;
}

export interface OpencodeHooks {
  event: (input: { event: OpencodeEvent }) => Promise<void>;
  "chat.message": (input: { sessionID: string; agent?: string; model?: OpencodeModel }, output: { parts: OpencodePart[] }) => Promise<void>;
  "experimental.chat.system.transform": (input: { sessionID?: string }, output: { system: string[] }) => Promise<void>;
  "experimental.text.complete": (input: { sessionID: string; messageID: string }, output: { text: string }) => Promise<void>;
  "tool.execute.after": (input: { tool: string; sessionID: string; args: unknown }) => Promise<void>;
  "experimental.session.compacting": (input: { sessionID: string }) => Promise<void>;
}

export interface OpencodeHookDeps {
  client: OpencodeClient;
  // The project directory opencode was started in; sessions report their own when they differ.
  directory: string;
  openTap: (session: string, cwd: string) => Promise<Tap | null>;
  // Longest the first model request waits for the session-start inject.
  injectWaitMs?: number;
  now?: () => number;
}

const INJECT_WAIT_MS = 4000;
const WRITE_TOOLS = new Set(["edit", "write", "multiedit", "apply_patch"]);

interface SessionState {
  tap: Tap | null;
  opened: Promise<void>;
  started: Promise<void>;
  inject: string;
  queue: Promise<void>;
  // One entry per assistant message, for the checkpoint counter.
  entries: TranscriptEntry[];
  lastMessage: string;
  // Files touched since the last text part.
  paths: string[];
  nudge: string | null;
  agent?: string;
  model?: OpencodeModel;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function partsText(parts: OpencodePart[]): string {
  return parts
    .filter((p) => p.type === "text" && typeof p.text === "string" && !p.synthetic)
    .map((p) => p.text ?? "")
    .join("\n")
    .trim();
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Maps opencode's hooks onto one Tap per session. `opencode run` exits ~20ms after session.idle
// without waiting for event handlers, so turns are spooled from the awaited hooks (chat.message,
// text.complete, tool.execute.after) and never from an HTTP read-back; events only flush, nudge
// and clean up. The inject goes into the system prompt on every model request of the session,
// which keeps it in place across turns and stable for prompt caching.
export function createOpencodeHooks(deps: OpencodeHookDeps): OpencodeHooks {
  const sessions = new Map<string, SessionState>();
  // Subagent sessions (parentID set) are the main session's tool calls, not conversations.
  const children = new Set<string>();
  const now = deps.now ?? Date.now;

  const start = (s: SessionState): Promise<void> =>
    s.opened
      .then(async () => {
        if (s.tap) s.inject = await s.tap.start();
      })
      .catch(() => undefined);

  const open = (id: string, cwd: string): SessionState => {
    const existing = sessions.get(id);
    if (existing) return existing;
    const s: SessionState = {
      tap: null,
      opened: Promise.resolve(),
      started: Promise.resolve(),
      inject: "",
      queue: Promise.resolve(),
      entries: [],
      lastMessage: "",
      paths: [],
      nudge: null,
    };
    s.opened = deps
      .openTap(id, cwd)
      .then((tap) => {
        s.tap = tap;
      })
      .catch(() => undefined);
    s.started = start(s);
    sessions.set(id, s);
    return s;
  };

  // Mesh calls run in order per session, once the tap is open, and never surface.
  const enqueue = (s: SessionState, fn: (tap: Tap) => Promise<void>): Promise<void> => {
    s.queue = s.queue
      .then(() => s.opened)
      .then(() => (s.tap ? fn(s.tap) : undefined))
      .catch(() => undefined);
    return s.queue;
  };

  const tracked = (id: string | undefined): SessionState | undefined => (id && !children.has(id) ? sessions.get(id) : undefined);

  return {
    event: async ({ event }) => {
      const p = isRecord(event.properties) ? event.properties : {};
      const info = isRecord(p.info) ? p.info : {};
      switch (event.type) {
        case "session.created": {
          if (typeof info.id !== "string") return;
          if (typeof info.parentID === "string") children.add(info.id);
          else open(info.id, typeof info.directory === "string" ? info.directory : deps.directory);
          return;
        }
        case "session.compacted": {
          const s = tracked(typeof p.sessionID === "string" ? p.sessionID : undefined);
          if (s) s.started = start(s);
          return;
        }
        case "session.idle": {
          const id = typeof p.sessionID === "string" ? p.sessionID : undefined;
          const s = tracked(id);
          if (!s || !id) return;
          await enqueue(s, async (tap) => {
            await tap.flush(false);
            const nudge = tap.nudge(s.entries);
            if (!nudge) return;
            s.nudge = nudge;
            await deps.client.session.promptAsync({
              path: { id },
              body: { ...(s.agent ? { agent: s.agent } : {}), ...(s.model ? { model: s.model } : {}), parts: [{ type: "text", text: nudge }] },
            });
          });
          return;
        }
        case "session.deleted": {
          if (typeof info.id !== "string") return;
          children.delete(info.id);
          const s = sessions.get(info.id);
          sessions.delete(info.id);
          if (s) await enqueue(s, (tap) => tap.end());
          return;
        }
        default:
          return;
      }
    },

    "chat.message": async (input, output) => {
      if (children.has(input.sessionID)) return;
      // Sessions resumed from before the plugin loaded never emitted session.created.
      const s = open(input.sessionID, deps.directory);
      if (input.agent) s.agent = input.agent;
      if (input.model) s.model = input.model;
      const text = partsText(output.parts);
      if (s.nudge && text === s.nudge) {
        s.nudge = null;
        return;
      }
      s.paths = [];
      await enqueue(s, (tap) => tap.user(text));
    },

    "experimental.chat.system.transform": async (input, output) => {
      const s = tracked(input.sessionID);
      if (!s) return;
      await Promise.race([s.started, sleep(deps.injectWaitMs ?? INJECT_WAIT_MS)]);
      if (s.inject) output.system.push(s.inject);
    },

    "experimental.text.complete": async (input, output) => {
      const s = tracked(input.sessionID);
      if (!s) return;
      const text = output.text.trim();
      const paths = s.paths;
      s.paths = [];
      if (!text && paths.length === 0) return;
      const last = s.entries.at(-1);
      if (last && s.lastMessage === input.messageID) {
        last.text = [last.text, text].filter(Boolean).join("\n\n");
        last.paths = [...new Set([...last.paths, ...paths])];
        last.at = now();
      } else {
        s.entries.push({ role: "assistant", text, paths, at: now() });
        s.lastMessage = input.messageID;
      }
      await enqueue(s, (tap) => tap.assistant(text, paths));
    },

    "tool.execute.after": async (input) => {
      const s = tracked(input.sessionID);
      if (!s || !WRITE_TOOLS.has(input.tool) || !isRecord(input.args)) return;
      const file = input.args.filePath;
      if (typeof file === "string" && file) s.paths.push(file);
    },

    "experimental.session.compacting": async (input) => {
      const s = tracked(input.sessionID);
      if (s) await enqueue(s, (tap) => tap.end());
    },
  };
}
