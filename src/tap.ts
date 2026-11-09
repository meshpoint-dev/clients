import path from "node:path";
import { MeshpointClient, MeshpointError, type Presence, type RecallResponse } from "@meshpoint/sdk";
import type { Checkpoints } from "./checkpoints.js";
import { SKILL_NAME } from "./claude-code/skill.js";
import type { TranscriptEntry } from "./claude-code/transcript.js";
import type { Config, RepoContext } from "./config.js";
import { ID_PREFIX_CHARS } from "./items.js";
import type { Spool, SpooledTurn } from "./spool.js";

export interface TapCoreDeps {
  config: Config;
  repo: RepoContext;
  // The harness's own session id; spool files and nudge records are keyed by it.
  session: string;
  spool: Spool;
  checkpoints: Checkpoints;
  now?: () => number;
  fetch?: typeof fetch;
  // Longest the session-start inject waits for teammates after items have arrived.
  presenceWaitMs?: number;
  // Called once after a 401 (org key rotated, token revoked); returns the renewed config or null.
  refresh?: () => Promise<Config | null>;
}

const DEFAULT_PRESENCE_WAIT_MS = 1500;

type SendResult = "ok" | "failed" | "unauthorized";

// One harness session's side of the mesh, independent of how the harness delivers events: recall
// and presence rendered for injection at start, turns spooled and flushed in 60s batches, and the
// checkpoint nudge once enough replies pile up. Every method swallows mesh failures: a broken
// mesh must never break the harness.
export class Tap {
  private config: Config;

  constructor(private readonly deps: TapCoreDeps) {
    this.config = deps.config;
  }

  get repo(): RepoContext {
    return this.deps.repo;
  }

  // The context block for the start of a session, or "" when there is nothing to say.
  async start(): Promise<string> {
    try {
      const { recall, presence } = await this.client(this.repo.branch)
        .sessionStart()
        .catch(async (err: unknown) => {
          if (!is401(err) || !(await this.reauth())) throw err;
          return this.client(this.repo.branch).sessionStart();
        });
      const teammates = await Promise.race([
        presence,
        new Promise<Presence[]>((r) => setTimeout(() => r([]), this.deps.presenceWaitMs ?? DEFAULT_PRESENCE_WAIT_MS)),
      ]);
      const text = renderInject(this.repo, recall, teammates, this.now());
      await this.flush(false);
      return text;
    } catch {
      return "";
    }
  }

  async user(prompt: string): Promise<void> {
    if (prompt) this.spoolTurn(`[user] ${prompt}`);
    await this.flush(false);
  }

  async assistant(text: string, paths: string[] = []): Promise<void> {
    if (text || paths.length > 0) this.spoolTurn(`[assistant] ${text}`, paths);
    await this.flush(false);
  }

  // The nudge to show the agent when a checkpoint is due, else null. Recording the nudge keeps an
  // ignored one from repeating on every reply.
  nudge(entries: readonly TranscriptEntry[]): string | null {
    const due = this.deps.checkpoints.due(this.deps.session, this.repo.project, this.repo.branch, entries);
    if (!due) return null;
    this.deps.checkpoints.markNudge(this.deps.session, this.now());
    return `Meshpoint checkpoint due (${due.turns} replies since the last one). Run the ${SKILL_NAME} skill now, then continue.`;
  }

  // Session end and pre-compaction: send whatever is spooled now.
  async end(): Promise<void> {
    await this.flush(true);
  }

  async flush(force: boolean): Promise<void> {
    try {
      if (!this.deps.spool.isDue(this.deps.session, this.now(), force)) return;
      const taken = this.deps.spool.take(this.deps.session);
      let result = await this.send(taken.turns);
      if (result === "unauthorized" && (await this.reauth())) result = await this.send(taken.turns);
      if (result === "ok") taken.discard();
      else taken.restore();
    } catch {
      // The spool keeps the turns for the next event.
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private client(branch: string, onError?: (err: Error) => void): MeshpointClient {
    return new MeshpointClient({
      baseUrl: this.config.baseUrl,
      token: this.config.token,
      project: this.repo.project,
      branch,
      ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
      ...(onError ? { onError } : {}),
    });
  }

  private async reauth(): Promise<boolean> {
    const next = this.deps.refresh ? await this.deps.refresh() : null;
    if (!next) return false;
    this.config = next;
    return true;
  }

  private spoolTurn(body: string, paths: string[] = []): void {
    const rel = paths.map((p) => (path.isAbsolute(p) ? path.relative(this.repo.root, p) : p)).filter((p) => p && !p.startsWith(".."));
    const turn: SpooledTurn = { branch: this.repo.branch, body, at: this.now(), ...(rel.length ? { paths: rel } : {}) };
    this.deps.spool.append(this.deps.session, turn);
  }

  // The SDK reports a failed flush through onError instead of throwing.
  private async send(turns: SpooledTurn[]): Promise<SendResult> {
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
        const c = this.client(branch, note);
        for (const t of batch) c.capture({ body: t.body, at: t.at, ...(t.paths ? { paths: t.paths } : {}) });
        await c.close();
      }
    } catch (err) {
      note(err);
    }
    return failed ? (unauthorized ? "unauthorized" : "failed") : "ok";
  }
}

function is401(err: unknown): boolean {
  return err instanceof MeshpointError && err.status === 401;
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
