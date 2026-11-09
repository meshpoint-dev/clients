import { appendFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import type { Checkpoints } from "../checkpoints.js";
import type { TranscriptEntry } from "../claude-code/transcript.js";
import type { Config, Environment, RepoContext } from "../config.js";
import type { Spool } from "../spool.js";
import { Tap } from "../tap.js";

// The slice of an OpenClaw internal hook event the handler forwards (see pack.ts).
export interface OpenclawEvent {
  type?: string;
  action?: string;
  sessionKey?: string;
  context?: {
    sessionId?: string;
    workspaceDir?: string;
    content?: string;
    success?: boolean;
  };
}

export interface OpenclawTapDeps {
  config: Config;
  env: Environment;
  repo: (cwd: string) => RepoContext | null;
  spool: Spool;
  checkpoints: Checkpoints;
  replies: ReplyLog;
  now?: () => number;
  fetch?: typeof fetch;
  presenceWaitMs?: number;
  refresh?: () => Promise<Config | null>;
}

// What the handler reads back: the bootstrap context block, or a checkpoint nudge to show on the
// next turn.
export interface OpenclawTapOutput {
  inject?: string;
  nudge?: string;
}

const PROJECT_RE = /^[A-Za-z0-9._-]{1,128}$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,128}$/;

// The workspace's origin remote when it is a git checkout; otherwise MESHPOINT_PROJECT names the
// project explicitly, since a chat agent has no cwd to derive one from.
export function openclawRepo(workspaceDir: string | undefined, env: Environment, repo: (cwd: string) => RepoContext | null): RepoContext | null {
  if (workspaceDir) {
    const found = repo(workspaceDir);
    if (found) return found;
  }
  const project = env.MESHPOINT_PROJECT;
  if (!project || !PROJECT_RE.test(project)) return null;
  const branch = env.MESHPOINT_BRANCH || "main";
  if (!BRANCH_RE.test(branch)) return null;
  return { project, branch, root: workspaceDir ?? process.cwd() };
}

// OpenClaw exposes no transcript to hooks, so the tap keeps its own record of assistant replies
// per session for the checkpoint nudge: one line per message:sent, dropped once a nudge fires or
// the session is replaced.
export class ReplyLog {
  constructor(private readonly dir: string) {}

  private file(session: string): string {
    return path.join(this.dir, "openclaw-replies", `${session.replace(/[^A-Za-z0-9._-]/g, "_")}.jsonl`);
  }

  append(session: string, at: number, chars: number): void {
    const file = this.file(session);
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    appendFileSync(file, `${JSON.stringify({ at, chars })}\n`, { mode: 0o600 });
  }

  // Replies as transcript entries; the text is padding of the recorded length, which is all the
  // checkpoint counter reads.
  entries(session: string): TranscriptEntry[] {
    let raw: string;
    try {
      raw = readFileSync(this.file(session), "utf8");
    } catch {
      return [];
    }
    const out: TranscriptEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const { at, chars } = JSON.parse(line) as { at: number; chars: number };
        out.push({ role: "assistant", text: "".padEnd(chars), paths: [], at });
      } catch {
        continue;
      }
    }
    return out;
  }

  clear(session: string): void {
    rmSync(this.file(session), { force: true });
  }
}

// One OpenClaw event in, one JSON answer out. The Tap swallows mesh failures; this layer only maps
// OpenClaw's event contract onto it.
export async function runOpenclawTap(event: OpenclawEvent, deps: OpenclawTapDeps): Promise<string> {
  const key = `${event.type ?? ""}:${event.action ?? ""}`;
  const context = event.context ?? {};
  const repo = openclawRepo(context.workspaceDir, deps.env, deps.repo);
  if (!repo) return "{}";
  // Session keys differ between phases of one conversation; the session id does not.
  const session = context.sessionId || event.sessionKey || "unknown";
  const now = deps.now ?? Date.now;
  const tap = new Tap({
    config: deps.config,
    repo,
    session,
    spool: deps.spool,
    checkpoints: deps.checkpoints,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.presenceWaitMs !== undefined ? { presenceWaitMs: deps.presenceWaitMs } : {}),
    ...(deps.refresh ? { refresh: deps.refresh } : {}),
  });

  const out: OpenclawTapOutput = {};
  switch (key) {
    case "agent:bootstrap": {
      const text = await tap.start();
      if (text) out.inject = text;
      break;
    }
    case "message:received":
      await tap.user(context.content ?? "");
      break;
    case "message:sent": {
      if (context.success === false) break;
      const text = context.content ?? "";
      await tap.assistant(text);
      if (text) deps.replies.append(session, now(), text.length);
      const nudge = tap.nudge(deps.replies.entries(session));
      if (nudge) {
        deps.replies.clear(session);
        out.nudge = nudge;
      }
      break;
    }
    case "command:new":
    case "command:reset":
    case "session:auto-reset":
      await tap.end();
      deps.replies.clear(session);
      break;
    default:
      break;
  }
  return JSON.stringify(out);
}
