import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { MeshpointClient, type Item, type ItemInput } from "@meshpoint/sdk";
import type { Config, Environment } from "../config.js";
import { headSha } from "../refs.js";
import { discoverSessions, type DiscoveredSession, type DiscoverOptions } from "./discover.js";
import { consolidate, distillSession, prune, type MergedItem, type ProposedItem } from "./distill.js";
import { KINDS } from "@meshpoint/sdk";
import { renderReport, type BranchResult, type ProjectResult } from "./report.js";
import type { Runner } from "./runner.js";

// `meshpoint import sessions`: the whole flow, dry run by default. Nothing leaves the machine
// without --apply; anything older than the default window or outside the current repo asks first.

export const DEFAULT_SINCE_DAYS = 90;
export const TURNS_WINDOW_DAYS = 30;
const DISTILL_CONCURRENCY = 2;
const ALL_ITEMS_BUDGET = 100_000;
const CAPTURE_SESSIONS_MAX = 100;

export interface ImportOptions {
  config: Config;
  // The current repository (project id and root) when not importing every repo.
  current: { project: string; root: string; defaultBranch: string } | null;
  sinceDays: number;
  allRepos: boolean;
  withTurns: boolean;
  apply: boolean;
  // Send the proposal to the platform for review in the console instead of writing items.
  propose: boolean;
  yes: boolean;
  // Distill every session again instead of reusing cached per-session proposals.
  fresh?: boolean;
  minTurns: number;
  runner: Runner;
  stateDir: string;
  env?: Environment;
  home?: string;
  now?: () => number;
  fetch?: typeof fetch;
  discover?: (opts: DiscoverOptions) => DiscoveredSession[];
  confirm?: (question: string) => Promise<boolean>;
  log?: (line: string) => void;
  exists?: (abs: string) => boolean;
  // Whether a recorded branch still carries work of its own; the default asks git.
  branchState?: (root: string, branch: string, defaultBranch: string) => BranchState;
}

// "gone": no local or remote ref; "merged": already in the default branch; "live": still its own.
export type BranchState = "gone" | "merged" | "live";

export function gitBranchState(root: string, branch: string, defaultBranch: string): BranchState {
  const ok = (args: string[]) => spawnSync("git", ["-C", root, ...args], { stdio: "ignore", timeout: 2000 }).status === 0;
  const local = ok(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  const remote = !local && ok(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]);
  if (!local && !remote) return "gone";
  return ok(["merge-base", "--is-ancestor", local ? branch : `origin/${branch}`, defaultBranch]) ? "merged" : "live";
}

// Per-session proposals survive between runs: a session whose file has not changed is not distilled again.
interface CacheEntry {
  mtime: number;
  size: number;
  items: ProposedItem[];
}

function fileStamp(file: string): { mtime: number; size: number } | null {
  try {
    const st = statSync(file);
    return { mtime: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

function readCache(file: string, stamp: { mtime: number; size: number }): ProposedItem[] | null {
  try {
    const c = JSON.parse(readFileSync(file, "utf8")) as CacheEntry;
    return c.mtime === stamp.mtime && c.size === stamp.size && Array.isArray(c.items) ? c.items : null;
  } catch {
    return null;
  }
}

// One branch of a saved proposal, the file a user edits between the dry run and --apply --from.
export interface SavedBranch {
  branch: string;
  items: Array<MergedItem & { refs: string[]; created_at?: number; harnesses?: string[] }>;
  dropped: Array<MergedItem & { missing: string[] }>;
}

export interface ImportOutcome {
  results: ProjectResult[];
  unmapped: DiscoveredSession[];
  reportFile: string;
  itemsFiles: string[];
  uploaded: { items: number; turns: number };
  // Console review links, one per project, when --propose was used.
  proposals: Array<{ project: string; id: string; url: string }>;
  cancelled: boolean;
}

async function askTty(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise<string>((r) => rl.question(`${question} [y/N] `, r));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function mapPool<T, R>(items: readonly T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (i < items.length) {
        const n = i++;
        out[n] = await fn(items[n] as T);
      }
    }),
  );
  return out;
}

function safe(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_");
}

export async function importSessions(opts: ImportOptions): Promise<ImportOutcome> {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((l: string) => process.stderr.write(`${l}\n`));
  const confirm = opts.confirm ?? askTty;
  const discover = opts.discover ?? discoverSessions;
  const since = now() - opts.sinceDays * 86_400_000;

  if (!opts.allRepos && !opts.current) throw new Error("not inside a git repo with an origin remote; pass --all-repos to import every repository");
  // Outside --all-repos only this repository's transcripts are read in full; the rest is skimmed or skipped.
  const all = discover({
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.home ? { home: opts.home } : {}),
    since,
    ...(opts.allRepos || !opts.current ? {} : { project: opts.current.project, roots: [opts.current.root] }),
  });
  const inWindow = all.filter((s) => s.endedAt >= since && (s.skimmed || s.entries.length >= opts.minTurns));
  const unmapped = inWindow.filter((s) => s.project === null);
  let selected = inWindow.filter((s) => s.project !== null && !s.skimmed);
  if (!opts.allRepos) selected = selected.filter((s) => s.project === opts.current!.project);
  const empty: ImportOutcome = { results: [], unmapped, reportFile: "", itemsFiles: [], uploaded: { items: 0, turns: 0 }, proposals: [], cancelled: false };
  if (selected.length === 0) {
    log(`no sessions found${opts.allRepos ? "" : ` for ${opts.current?.project}`} in the last ${opts.sinceDays} days (${inWindow.length} in the window, ${unmapped.length} unmapped)`);
    return empty;
  }

  // Confirm before reading beyond the defaults.
  const needsConfirm = opts.sinceDays > DEFAULT_SINCE_DAYS || opts.allRepos;
  if (needsConfirm && !opts.yes) {
    const projects = [...new Set(selected.map((s) => s.project))];
    log(`About to read ${selected.length} session transcripts from ${projects.length} repositor${projects.length === 1 ? "y" : "ies"} going back ${opts.sinceDays} days:`);
    for (const p of projects.slice(0, 30)) log(`  ${p} (${selected.filter((s) => s.project === p).length})`);
    if (projects.length > 30) log(`  ... and ${projects.length - 30} more`);
    if (!(await confirm("Continue? Transcripts are distilled with your own agent CLI; nothing is uploaded without --apply."))) {
      log("cancelled");
      return { ...empty, cancelled: true };
    }
  }

  const byProject = new Map<string, DiscoveredSession[]>();
  for (const s of selected) byProject.set(s.project as string, [...(byProject.get(s.project as string) ?? []), s]);
  const results: ProjectResult[] = [];
  const itemsFiles: string[] = [];
  const uploaded = { items: 0, turns: 0 };
  const sent: ImportOutcome["proposals"] = [];
  const outDir = path.join(opts.stateDir, "import");
  const cacheDir = path.join(outDir, "cache");
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const branchState = opts.branchState ?? gitBranchState;

  for (const [project, sessions] of byProject) {
    const root = opts.current?.project === project ? opts.current.root : (sessions.find((s) => s.cwd && existsSync(s.cwd))?.cwd ?? "");
    const defaultBranch = opts.current?.project === project ? opts.current.defaultBranch : "master";
    const result: ProjectResult = { project, root, sessions, branches: [], folded: [], errors: [] };
    log(`${project}: distilling ${sessions.length} session${sessions.length === 1 ? "" : "s"} with ${opts.runner.name}`);
    const proposals = await mapPool(sessions, DISTILL_CONCURRENCY, async (s) => {
      const stamp = fileStamp(s.file);
      const cacheFile = path.join(cacheDir, `${safe(s.harness)}-${safe(s.id)}.json`);
      const cached = stamp && !opts.fresh ? readCache(cacheFile, stamp) : null;
      if (cached) {
        log(`  ${s.harness} ${s.id.slice(0, 8)} (${s.entries.length} turns): ${cached.length} proposed (cached)`);
        return { s, items: cached };
      }
      try {
        const { items, unsupported } = await distillSession(opts.runner, s);
        log(`  ${s.harness} ${s.id.slice(0, 8)} (${s.entries.length} turns): ${items.length} proposed${unsupported ? `, ${unsupported} unsupported` : ""}`);
        if (stamp) writeFileSync(cacheFile, JSON.stringify({ ...stamp, items } satisfies CacheEntry), { mode: 0o600 });
        return { s, items };
      } catch (err) {
        result.errors.push(`${s.harness} ${s.id.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
        return { s, items: [] as ProposedItem[] };
      }
    });
    // Oldest first, so the consolidation pass can treat later sessions as newer.
    proposals.sort((a, b) => a.s.endedAt - b.s.endedAt);
    // A branch that is gone or already merged gets no items of its own: they go to the default branch.
    const placement = new Map<string, string>();
    const place = (recorded: string): string => {
      if (recorded === defaultBranch || !root) return recorded;
      const known = placement.get(recorded);
      if (known) return known;
      const state = branchState(root, recorded, defaultBranch);
      const target = state === "live" ? recorded : defaultBranch;
      if (state !== "live") result.folded.push({ branch: recorded, into: defaultBranch, why: state });
      placement.set(recorded, target);
      return target;
    };
    const byBranch = new Map<string, ProposedItem[]>();
    for (const p of proposals) {
      const branch = place(p.s.branch ?? defaultBranch);
      byBranch.set(branch, [...(byBranch.get(branch) ?? []), ...p.items]);
    }
    const client = (branch: string) => new MeshpointClient({ baseUrl: opts.config.baseUrl, token: opts.config.token, project, branch, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
    for (const [branch, proposed] of byBranch) {
      if (proposed.length === 0) continue;
      let live: Item[] = [];
      try {
        live = (await client(branch).recall({ budget: ALL_ITEMS_BUDGET, fresh: true })).items;
      } catch (err) {
        result.errors.push(`${branch}: could not read live items (${err instanceof Error ? err.message : String(err)}); consolidating without them`);
      }
      let merged: MergedItem[];
      try {
        merged = await consolidate(opts.runner, proposed, live);
      } catch (err) {
        result.errors.push(`${branch}: consolidation failed (${err instanceof Error ? err.message : String(err)}); using the per-session proposals`);
        merged = proposed;
      }
      const liveIds = new Set(live.map((i) => i.id));
      for (const m of merged) if (m.supersedes) m.supersedes = m.supersedes.filter((id) => liveIds.has(id));
      const { kept, dropped } = root ? prune(merged, root, opts.exists) : { kept: merged.map((m) => ({ ...m, refs: [] as string[] })), dropped: [] };
      const branchResult: BranchResult = { branch, items: kept, dropped };
      result.branches.push(branchResult);
      log(`  ${branch}: ${kept.length} items proposed, ${dropped.length} dropped`);
    }
    // The saved proposal carries what --apply --from needs without the transcripts: the date of the
    // newest source session and the harnesses it came from.
    const endedAt = (ids: readonly string[]) => Math.max(0, ...sessions.filter((s) => ids.includes(s.id)).map((s) => s.endedAt));
    const harnessesOf = (ids: readonly string[]) => [...new Set(sessions.filter((s) => ids.includes(s.id)).map((s) => s.harness))];
    const saved: SavedBranch[] = result.branches.map((b) => ({
      branch: b.branch,
      items: b.items.map((i) => ({ ...i, ...(endedAt(i.sessions) > 0 ? { created_at: endedAt(i.sessions) } : {}), harnesses: harnessesOf(i.sessions) })),
      dropped: b.dropped,
    }));
    const file = path.join(outDir, `${safe(project)}.items.json`);
    writeFileSync(file, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
    itemsFiles.push(file);

    if (opts.propose) {
      try {
        const res = await (opts.fetch ?? fetch)(`${opts.config.baseUrl.replace(/\/+$/, "")}/v1/imports`, {
          method: "POST",
          headers: { authorization: `Bearer ${opts.config.token}`, "content-type": "application/json" },
          body: JSON.stringify({ project, branches: saved, report: renderReport([result], [], {}).slice(0, 60_000), commit_sha: root ? headSha(root) : "" }),
        });
        const data = (await res.json()) as { id?: string; url?: string; error?: string };
        if (!res.ok || !data.id) throw new Error(data.error ?? `HTTP ${res.status}`);
        sent.push({ project, id: data.id, url: data.url ?? "" });
        log(`  proposal ${data.id} sent for review${data.url ? `: ${data.url}` : ""}`);
      } catch (err) {
        result.errors.push(`proposal upload failed (${err instanceof Error ? err.message : String(err)})`);
      }
    }

    if (opts.apply) {
      const out = await uploadProposal({ project, root, branches: saved, config: opts.config, runnerName: opts.runner.name, ...(opts.fetch ? { fetch: opts.fetch } : {}), ...(opts.exists ? { exists: opts.exists } : {}), log });
      uploaded.items += out.items;
      result.errors.push(...out.errors);
      if (opts.withTurns) {
        const cutoff = now() - TURNS_WINDOW_DAYS * 86_400_000;
        for (const s of sessions.filter((x) => x.endedAt >= cutoff).slice(0, CAPTURE_SESSIONS_MAX)) {
          const c = new MeshpointClient({ baseUrl: opts.config.baseUrl, token: opts.config.token, project, branch: s.branch ?? defaultBranch, session: s.id, flushMaxTurns: 200, ...(opts.fetch ? { fetch: opts.fetch } : {}), onError: (e) => result.errors.push(`${s.id.slice(0, 8)}: turns upload: ${e.message}`) });
          for (const e of s.entries) c.capture({ body: `[${e.role}] ${e.text}`, at: e.at || s.startedAt, ...(e.paths.length ? { paths: e.paths.map((p) => (root && path.isAbsolute(p) ? path.relative(root, p) : p)).filter((p) => p && !p.startsWith("..")) } : {}) });
          await c.close();
          uploaded.turns += s.entries.length;
        }
        log(`  turns uploaded for sessions in the last ${TURNS_WINDOW_DAYS} days: ${uploaded.turns}`);
      }
    }
    results.push(result);
  }

  for (const r of results) if (r.folded.length) log(`  ${r.project}: folded into ${r.folded[0]?.into}: ${r.folded.map((f) => `${f.branch} (${f.why})`).join(", ")}`);
  const report = renderReport(results, unmapped, { openclaw: "keeps no transcript on disk; nothing to import", cursor: "transcript store is undocumented; only files named like transcripts under ~/.cursor are tried" });
  const reportFile = path.join(outDir, `report-${new Date(now()).toISOString().slice(0, 10)}.txt`);
  writeFileSync(reportFile, `${report}\n`, { mode: 0o600 });
  log("");
  log(report);
  log("");
  if (opts.apply) log(`uploaded ${uploaded.items} items${opts.withTurns ? ` and ${uploaded.turns} turns` : ""}; proposals saved in ${outDir}`);
  else if (opts.propose) log(`sent for review in the console${sent.length ? `: ${sent.map((p) => p.url || p.id).join(", ")}` : ""}. Nothing is written until someone applies it there.`);
  else log(`dry run, nothing uploaded. Review the proposal: ${itemsFiles.join(", ")}\nDelete or edit entries there, then upload exactly that file with: meshpoint import sessions --apply --from <file>\nOr send it to the console for review with --propose, or run again with --apply to distill afresh and upload.`);
  return { results, unmapped, reportFile, itemsFiles, uploaded, proposals: sent, cancelled: false };
}

interface UploadInput {
  project: string;
  root: string;
  branches: readonly SavedBranch[];
  config: Config;
  runnerName: string;
  fetch?: typeof fetch;
  exists?: (abs: string) => boolean;
  log: (line: string) => void;
}

// Writes a proposal's branches through items put semantics: refs re-read from the item text (the
// file may have been edited), HEAD as the commit, import provenance, dates from the sessions.
async function uploadProposal(u: UploadInput): Promise<{ items: number; errors: string[] }> {
  const errors: string[] = [];
  let count = 0;
  const sha = u.root ? headSha(u.root) : "";
  for (const b of u.branches) {
    if (b.items.length === 0) continue;
    const { kept, dropped } = u.root ? prune(b.items, u.root, u.exists) : { kept: b.items.map((i) => ({ ...i, refs: i.refs ?? [] })), dropped: [] };
    for (const d of dropped) u.log(`  ${b.branch}: skipped "${d.title}" (missing ${d.missing.join(", ")})`);
    const inputs: ItemInput[] = kept.map((i) => {
      const src = b.items.find((x) => x.title === i.title && x.body === i.body);
      return {
        id: randomUUID(),
        kind: i.kind,
        title: i.title,
        body: i.body,
        ...(src?.created_at ? { created_at: src.created_at } : {}),
        refs: i.refs,
        paths: [],
        ...(sha ? { commit_sha: sha } : {}),
        ...(i.key ? { key: i.key } : {}),
        ...(i.supersedes && i.supersedes.length ? { supersedes: i.supersedes } : {}),
        provenance: JSON.stringify({ agent: `import:${(src?.harnesses ?? []).join("+") || u.runnerName}`, user: u.config.user ?? "", sessions: (i.sessions ?? []).slice(0, 20) }),
      };
    });
    if (inputs.length === 0) continue;
    try {
      const client = new MeshpointClient({ baseUrl: u.config.baseUrl, token: u.config.token, project: u.project, branch: b.branch, ...(u.fetch ? { fetch: u.fetch } : {}) });
      const out = await client.putItems(inputs);
      count += out.count;
      u.log(`  ${b.branch}: uploaded ${out.count} items${out.superseded ? `, ${out.superseded} superseded` : ""}`);
    } catch (err) {
      errors.push(`${b.branch}: upload failed (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  return { items: count, errors };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Reads a proposal file the user reviewed; anything malformed is an error, never a guess.
export function readProposal(file: string): SavedBranch[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${file}: expected an array of {branch, items}`);
  return parsed.map((b, n) => {
    if (!isRecord(b) || typeof b.branch !== "string" || !Array.isArray(b.items)) throw new Error(`${file}: entry ${n} needs branch and items`);
    const items = b.items.map((i, m) => {
      if (!isRecord(i) || typeof i.kind !== "string" || !(KINDS as readonly string[]).includes(i.kind) || i.kind === "status") throw new Error(`${file}: ${b.branch} item ${m}: kind must be one of ${KINDS.filter((k) => k !== "status").join(", ")}`);
      if (typeof i.title !== "string" || !i.title.trim() || typeof i.body !== "string" || !i.body.trim()) throw new Error(`${file}: ${b.branch} item ${m}: title and body required`);
      return {
        kind: i.kind as MergedItem["kind"],
        title: i.title.trim(),
        body: i.body.trim(),
        sessions: Array.isArray(i.sessions) ? i.sessions.filter((x): x is string => typeof x === "string") : [],
        refs: Array.isArray(i.refs) ? i.refs.filter((x): x is string => typeof x === "string") : [],
        ...(typeof i.key === "string" && i.key ? { key: i.key } : {}),
        ...(i.recurring === true ? { recurring: true } : {}),
        ...(typeof i.evidence === "string" && i.evidence.trim() ? { evidence: i.evidence.trim() } : {}),
        ...(Array.isArray(i.supersedes) ? { supersedes: i.supersedes.filter((x): x is string => typeof x === "string") } : {}),
        ...(typeof i.created_at === "number" ? { created_at: i.created_at } : {}),
        ...(Array.isArray(i.harnesses) ? { harnesses: i.harnesses.filter((x): x is string => typeof x === "string") } : {}),
      };
    });
    return { branch: b.branch, items, dropped: [] };
  });
}

export interface ApplyFileOptions {
  config: Config;
  file: string;
  current: { project: string; root: string } | null;
  fetch?: typeof fetch;
  exists?: (abs: string) => boolean;
  log?: (line: string) => void;
}

// `--apply --from <file>`: upload a reviewed proposal for the current repository, exactly as edited.
export async function applyProposalFile(opts: ApplyFileOptions): Promise<{ items: number; errors: string[] }> {
  if (!opts.current) throw new Error("--from uploads into the current repository; run it inside the repo the proposal was made for");
  const log = opts.log ?? ((l: string) => process.stderr.write(`${l}\n`));
  const branches = readProposal(opts.file);
  const out = await uploadProposal({ project: opts.current.project, root: opts.current.root, branches, config: opts.config, runnerName: "file", ...(opts.fetch ? { fetch: opts.fetch } : {}), ...(opts.exists ? { exists: opts.exists } : {}), log });
  log(`uploaded ${out.items} items from ${opts.file}`);
  for (const e of out.errors) log(`! ${e}`);
  return out;
}
