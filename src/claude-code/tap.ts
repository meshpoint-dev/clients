import path from "node:path";
import { MeshpointClient, MeshpointError, type Presence, type RecallResponse } from "@meshpoint/sdk";
import type { Config, RepoContext } from "../config.js";
import type { Checkpoints } from "../checkpoints.js";
import { ID_PREFIX_CHARS } from "../items.js";
import { Spool, type SpooledTurn } from "../spool.js";
import { SKILL_NAME } from "./skill.js";
import { lastAssistantTurn, parseTranscript as parseClaudeCodeTranscript, type TranscriptEntry } from "./transcript.js";

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
  // Longest the session-start inject waits for teammates after items have arrived.
  presenceWaitMs?: number;
  // Called once after a 401 (org key rotated, token revoked); returns the renewed config or null.
  refresh?: () => Promise<Config | null>;
}

const DEFAULT_PRESENCE_WAIT_MS = 1500;

// One hook event in, one JSON answer out. Claude Code and Codex share the hook protocol (event
// names, payload fields, additionalContext, Stop block), so one tap serves both. Never throws past
// this boundary: a broken mesh must not break the harness, so failures degrade to the empty answer.
export async function runClaudeCodeTap(payload: HookPayload, deps: TapDeps): Promise<string> {
  const event = payload.hook_event_name ?? "";
  const session = payload.session_id ?? "unknown";
  const now = deps.now ?? Date.now;
  const repo = deps.repo(payload.cwd ?? process.cwd());
  const empty = event === "Stop" ? '{"decision":"continue"}' : "{}";
  if (!repo) return empty;

  let config = deps.config;
  const is401 = (err: unknown) => err instanceof MeshpointError && err.status === 401;
  const reauth = async (): Promise<boolean> => {
    const next = deps.refresh ? await deps.refresh() : null;
    if (!next) return false;
    config = next;
    return true;
  };

  const client = (branch: string, onError?: (err: Error) => void) =>
    new MeshpointClient({
      baseUrl: config.baseUrl,
      token: config.token,
      project: repo.project,
      branch,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(onError ? { onError } : {}),
    });

  const transcript = () => {
    if (!payload.transcript_path) return [];
    try {
      return (deps.parseTranscript ?? parseClaudeCodeTranscript)(deps.readTranscript(payload.transcript_path));
    } catch {
      return [];
    }
  };

  const spoolTurn = (body: string, paths: string[] = []): void => {
    const rel = paths.map((p) => (path.isAbsolute(p) ? path.relative(repo.root, p) : p)).filter((p) => p && !p.startsWith(".."));
    const turn: SpooledTurn = { branch: repo.branch, body, at: now(), ...(rel.length ? { paths: rel } : {}) };
    deps.spool.append(session, turn);
  };

  // The SDK reports a failed flush through onError instead of throwing.
  const send = async (turns: SpooledTurn[]): Promise<"ok" | "failed" | "unauthorized"> => {
    const byBranch = new Map<string, SpooledTurn[]>();
    for (const t of turns) byBranch.set(t.branch, [...(byBranch.get(t.branch) ?? []), t]);
    let failed = false;
    let unauthorized = false;
    const note = (err: unknown) => {
      failed = true;
      if (is401(err)) unauthorized = true;
    };
    try {
      for (const [branch, batch] of byBranch) {
        const c = client(branch, note);
        for (const t of batch) c.capture({ body: t.body, at: t.at, ...(t.paths ? { paths: t.paths } : {}) });
        await c.close();
      }
    } catch (err) {
      note(err);
    }
    return failed ? (unauthorized ? "unauthorized" : "failed") : "ok";
  };

  const flush = async (force: boolean): Promise<void> => {
    if (!deps.spool.isDue(session, now(), force)) return;
    const taken = deps.spool.take(session);
    let result = await send(taken.turns);
    if (result === "unauthorized" && (await reauth())) result = await send(taken.turns);
    if (result === "ok") taken.discard();
    else taken.restore();
  };

  try {
    switch (event) {
      case "SessionStart": {
        const { recall, presence } = await client(repo.branch)
          .sessionStart()
          .catch(async (err: unknown) => {
            if (!is401(err) || !(await reauth())) throw err;
            return client(repo.branch).sessionStart();
          });
        const teammates = await Promise.race([
          presence,
          new Promise<Presence[]>((r) => setTimeout(() => r([]), deps.presenceWaitMs ?? DEFAULT_PRESENCE_WAIT_MS)),
        ]);
        const text = renderInject(repo, recall, teammates, now());
        await flush(false);
        return text ? JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } }) : "{}";
      }
      case "UserPromptSubmit": {
        if (payload.prompt) spoolTurn(`[user] ${payload.prompt}`);
        await flush(false);
        return "{}";
      }
      case "Stop": {
        const entries = transcript();
        const turn = lastAssistantTurn(entries);
        if (turn) spoolTurn(`[assistant] ${turn.text}`, turn.paths);
        await flush(false);
        // A due checkpoint keeps the turn going so the agent writes its items now. stop_hook_active
        // means this Stop is already a continuation; never nudge twice in a row.
        const due = payload.stop_hook_active ? null : deps.checkpoints.due(session, repo.project, repo.branch, entries);
        if (!due) return '{"decision":"continue"}';
        deps.checkpoints.markNudge(session, now());
        return JSON.stringify({
          decision: "block",
          reason: `Meshpoint checkpoint due (${due.turns} replies since the last one). Run the ${SKILL_NAME} skill now, then continue.`,
        });
      }
      case "PreCompact": {
        await flush(true);
        return "{}";
      }
      case "SessionEnd": {
        await flush(true);
        return "{}";
      }
      default:
        return empty;
    }
  } catch {
    return empty;
  }
}

function age(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

export function renderInject(repo: RepoContext, recall: RecallResponse, presence: Presence[], now: number): string {
  if (recall.items.length === 0 && !recall.checkpoint && presence.length === 0) return "";
  const lines: string[] = [`# Meshpoint: ${repo.project} @ ${repo.branch}`];
  if (presence.length > 0) {
    lines.push("", "## Teammates active now");
    for (const p of presence) lines.push(`- ${p.user} (${p.agent}, ${age(now - p.updated_at)})${p.paths.length ? `: ${p.paths.join(", ")}` : ""}`);
  }
  if (recall.checkpoint) {
    lines.push("", `## Last checkpoint (${age(now - recall.checkpoint.created_at)})`, recall.checkpoint.body);
  }
  if (recall.items.length > 0) {
    lines.push("", `## Team knowledge (${recall.items.length}; first column is the item id)`);
    for (const i of recall.items) lines.push(`- ${i.id.slice(0, ID_PREFIX_CHARS)} [${i.kind}] ${i.title}: ${i.body}`);
  }
  return lines.join("\n");
}
