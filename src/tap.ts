import path from "node:path";
import { isExpired, MeshpointClient, MeshpointError, redact, type Item, type Presence, type RecallResponse } from "@meshpoint/sdk";
import type { Checkpoints } from "./checkpoints.js";
import { SKILL_NAME } from "./claude-code/skill.js";
import type { TranscriptEntry } from "./claude-code/transcript.js";
import type { Config, RepoContext } from "./config.js";
import { instructionFiles, itemsForFile, renderEditNotice, renderImportNudge, type SessionCache } from "./context.js";
import { ID_PREFIX_CHARS } from "./items.js";
import type { Spool, SpooledTurn } from "./spool.js";
import type { Touched } from "./touched.js";
import { gitRunner, sightings, verifyItems, type Verdict } from "./verify.js";

// Checks that need the checkout: verification of items and the search for instruction files.
export interface LocalChecks {
  verify(items: readonly Item[]): Map<string, Verdict>;
  instructionFiles(): string[];
}

export function localChecks(root: string): LocalChecks {
  const git = gitRunner(root);
  return {
    verify: (items) => verifyItems(items, root, { git }),
    instructionFiles: () => instructionFiles(git),
  };
}

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
  // Files edited on the branch, for the next checkpoint's items. Absent: not recorded.
  touched?: Touched;
  // Session-start items and edit notices already shown, for the edit hook. Absent: no edit context.
  cache?: SessionCache;
  // Verification against the checkout and the import nudge. Absent: items are not verified.
  local?: LocalChecks;
}

const DEFAULT_PRESENCE_WAIT_MS = 1500;
// The inject is cut to this many tokens of items; the request asks for everything so the
// verification pass and the edit hook see the whole branch.
export const INJECT_BUDGET_TOKENS = 3000;
const ALL_ITEMS_BUDGET = 100_000;
// Longest the session-start hook waits for the platform to take the sightings.
const VERIFY_SEND_WAIT_MS = 800;
// Longest an edit waits for presence from the origin before the local items go out alone.
const EDIT_WAIT_MS = 1000;
const STALE_LIST_MAX = 20;
// Harnesses that feed the nudge back as a user prompt (Cursor) match on this to keep it out of the capture.
export const NUDGE_PREFIX = "Meshpoint checkpoint due";

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
        .sessionStart({ budget: ALL_ITEMS_BUDGET })
        .catch(async (err: unknown) => {
          if (!is401(err) || !(await this.reauth())) throw err;
          return this.client(this.repo.branch).sessionStart({ budget: ALL_ITEMS_BUDGET });
        });
      const verdicts = this.deps.local ? this.deps.local.verify(recall.items) : new Map<string, Verdict>();
      this.deps.cache?.saveRecall(this.deps.session, {
        project: this.repo.project,
        branch: this.repo.branch,
        items: recall.items,
        verdicts: Object.fromEntries(verdicts),
        at: this.now(),
      });
      const report = sightings(verdicts);
      const sent = report.length > 0 ? this.client(this.repo.branch).verify(report).catch(() => undefined) : Promise.resolve(undefined);
      const teammates = await Promise.race([
        presence,
        new Promise<Presence[]>((r) => setTimeout(() => r([]), this.deps.presenceWaitMs ?? DEFAULT_PRESENCE_WAIT_MS)),
      ]);
      let text = renderInject(this.repo, recall, teammates, this.now(), verdicts);
      const nudge = this.importNudge(recall);
      if (nudge) text = `${text || `# Meshpoint: ${this.repo.project} @ ${this.repo.branch}`}\n\n${nudge}`;
      await this.flush(false);
      await Promise.race([sent, new Promise<void>((r) => setTimeout(r, VERIFY_SEND_WAIT_MS))]);
      return text;
    } catch {
      return "";
    }
  }

  // A branch with no memory and committed instruction files gets one invitation to import them.
  private importNudge(recall: RecallResponse): string {
    if (!this.deps.local || !this.deps.cache || recall.items.length > 0 || recall.checkpoint) return "";
    const files = this.deps.local.instructionFiles();
    if (files.length === 0 || !this.deps.cache.firstImportNudge(this.repo.project, this.repo.branch)) return "";
    return renderImportNudge(files);
  }

  // The notice for one file about to be edited (or just edited), or "". Items come from the
  // session-start cache with the local verdicts; presence comes from the origin, briefly.
  async edit(filePath: string): Promise<string> {
    try {
      const rel = this.relative(filePath);
      if (!rel) return "";
      if (this.deps.cache && !this.deps.cache.firstEdit(this.deps.session, rel)) return "";
      const cached = this.deps.cache?.loadRecall(this.deps.session);
      const ctx = await Promise.race([
        this.client(this.repo.branch).context(rel).catch(() => null),
        new Promise<null>((r) => setTimeout(() => r(null), EDIT_WAIT_MS)),
      ]);
      const items = cached ? itemsForFile(cached.items, cached.verdicts, rel) : (ctx?.items ?? []);
      return renderEditNotice(rel, items, ctx?.presence ?? [], this.now());
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
    this.deps.touched?.append(this.repo.project, this.repo.branch, this.relativeAll(paths), this.now());
    await this.flush(false);
  }

  // The nudge to show the agent when a checkpoint is due, else null. Recording the nudge keeps an
  // ignored one from repeating on every reply.
  nudge(entries: readonly TranscriptEntry[]): string | null {
    const due = this.deps.checkpoints.due(this.deps.session, this.repo.project, this.repo.branch, entries);
    if (!due) return null;
    this.deps.checkpoints.markNudge(this.deps.session, this.now());
    return `${NUDGE_PREFIX} (${due.turns} replies since the last one). Run the ${SKILL_NAME} skill now, then continue.`;
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

  // Repo-relative with forward slashes, or null for a path outside the repository.
  private relative(p: string): string | null {
    const rel = path.isAbsolute(p) ? path.relative(this.repo.root, p) : path.normalize(p);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    return rel.split(path.sep).join("/");
  }

  private relativeAll(paths: readonly string[]): string[] {
    return [...new Set(paths.map((p) => this.relative(p)).filter((p): p is string => p !== null))];
  }

  // Credentials are masked before the turn touches the spool file, so nothing on disk or on the
  // wire holds them. The SDK masks again on send for callers that bypass the spool.
  private spoolTurn(body: string, paths: string[] = []): void {
    const rel = this.relativeAll(paths);
    const turn: SpooledTurn = { branch: this.repo.branch, body: redact(body), at: this.now(), ...(rel.length ? { paths: rel } : {}) };
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

function estimateTokens(item: Pick<Item, "title" | "body">): number {
  return Math.ceil((item.title.length + item.body.length) / 4) + 8;
}

// Items arrive ranked from the platform; the budget cut happens here. Stale items (a referenced
// file is gone in this checkout) leave the list for a short section of their own; suspect items
// (a referenced file changed since) stay, marked. Items the platform already marks suspect from
// other checkouts carry the mark too.
export function renderInject(repo: RepoContext, recall: RecallResponse, presence: Presence[], now: number, verdicts: ReadonlyMap<string, Verdict> = new Map()): string {
  if (recall.items.length === 0 && !recall.checkpoint && presence.length === 0) return "";
  const lines: string[] = [`# Meshpoint: ${repo.project} @ ${repo.branch}`];
  if (presence.length > 0) {
    lines.push("", "## Teammates active now");
    for (const p of presence) lines.push(`- ${p.user} (${p.agent}, ${age(now - p.updated_at)})${p.paths.length ? `: ${p.paths.join(", ")}` : ""}`);
  }
  if (recall.checkpoint) {
    lines.push("", `## Last checkpoint (${age(now - recall.checkpoint.created_at)})`, recall.checkpoint.body);
  }
  // A blob served from the edge may predate an item's expiry or replacement; apply both rules here too.
  const current = recall.items.filter((i) => !i.retracted && i.state !== "dropped" && i.state !== "superseded" && !isExpired(i, now));
  const stale = current.filter((i) => verdicts.get(i.id) === "stale");
  const live: Item[] = [];
  let used = 0;
  for (const i of current) {
    if (verdicts.get(i.id) === "stale") continue;
    const t = estimateTokens(i);
    if (used + t > INJECT_BUDGET_TOKENS) break;
    live.push(i);
    used += t;
  }
  if (live.length > 0) {
    const marked = live.some((i) => isSuspect(i, verdicts));
    lines.push("", `## Team knowledge (${live.length}; first column is the item id${marked ? ", ? means a referenced file changed since" : ""})`);
    for (const i of live) lines.push(`- ${i.id.slice(0, ID_PREFIX_CHARS)}${isSuspect(i, verdicts) ? "?" : ""} [${i.kind}] ${i.title}: ${i.body}`);
  }
  if (stale.length > 0) {
    lines.push("", "## Possibly stale (a referenced file is gone; verify, then retract or rewrite)");
    for (const i of stale.slice(0, STALE_LIST_MAX)) lines.push(`- ${i.id.slice(0, ID_PREFIX_CHARS)} [${i.kind}] ${i.title}`);
  }
  return lines.join("\n");
}

// A local verdict wins; without one (or when the checkout could not judge) the platform's state stands.
function isSuspect(item: Item, verdicts: ReadonlyMap<string, Verdict>): boolean {
  const local = verdicts.get(item.id);
  if (local === "verified") return false;
  if (local === "suspect") return true;
  return (local === undefined || local === "skipped") && item.state === "suspect";
}
