import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { MeshpointClient, type Item, type ItemInput } from "@meshpoint/sdk";
import type { Config, Environment } from "../config.js";
import { headSha } from "../refs.js";
import { discoverSessions, type DiscoveredSession, type DiscoverOptions } from "./discover.js";
import { consolidate, distillSession, prune, type MergedItem, type ProposedItem } from "./distill.js";
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
  yes: boolean;
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
}

export interface ImportOutcome {
  results: ProjectResult[];
  unmapped: DiscoveredSession[];
  reportFile: string;
  itemsFiles: string[];
  uploaded: { items: number; turns: number };
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

  const all = discover({ ...(opts.env ? { env: opts.env } : {}), ...(opts.home ? { home: opts.home } : {}) });
  const inWindow = all.filter((s) => s.endedAt >= since && s.entries.length >= opts.minTurns);
  const unmapped = inWindow.filter((s) => s.project === null);
  let selected = inWindow.filter((s) => s.project !== null);
  if (!opts.allRepos) {
    if (!opts.current) throw new Error("not inside a git repo with an origin remote; pass --all-repos to import every repository");
    selected = selected.filter((s) => s.project === opts.current!.project);
  }
  const empty: ImportOutcome = { results: [], unmapped, reportFile: "", itemsFiles: [], uploaded: { items: 0, turns: 0 }, cancelled: false };
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
  const outDir = path.join(opts.stateDir, "import");
  mkdirSync(outDir, { recursive: true, mode: 0o700 });

  for (const [project, sessions] of byProject) {
    const root = opts.current?.project === project ? opts.current.root : (sessions.find((s) => s.cwd && existsSync(s.cwd))?.cwd ?? "");
    const defaultBranch = opts.current?.project === project ? opts.current.defaultBranch : "master";
    const result: ProjectResult = { project, root, sessions, branches: [], errors: [] };
    log(`${project}: distilling ${sessions.length} session${sessions.length === 1 ? "" : "s"} with ${opts.runner.name}`);
    const proposals = await mapPool(sessions, DISTILL_CONCURRENCY, async (s) => {
      try {
        const items = await distillSession(opts.runner, s);
        log(`  ${s.harness} ${s.id.slice(0, 8)} (${s.entries.length} turns): ${items.length} proposed`);
        return { s, items };
      } catch (err) {
        result.errors.push(`${s.harness} ${s.id.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
        return { s, items: [] as ProposedItem[] };
      }
    });
    // Oldest first, so the consolidation pass can treat later sessions as newer.
    proposals.sort((a, b) => a.s.endedAt - b.s.endedAt);
    const byBranch = new Map<string, ProposedItem[]>();
    for (const p of proposals) {
      const branch = p.s.branch ?? defaultBranch;
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
    const file = path.join(outDir, `${safe(project)}.items.json`);
    writeFileSync(file, `${JSON.stringify(result.branches.map((b) => ({ branch: b.branch, items: b.items, dropped: b.dropped })), null, 2)}\n`, { mode: 0o600 });
    itemsFiles.push(file);

    if (opts.apply) {
      const sha = root ? headSha(root) : "";
      for (const b of result.branches) {
        if (b.items.length === 0) continue;
        // Items are dated by the newest session that produced them, so ranking and decay see the
        // real age rather than the import time.
        const endedAt = (ids: readonly string[]) => Math.max(0, ...sessions.filter((s) => ids.includes(s.id)).map((s) => s.endedAt));
        const inputs: ItemInput[] = b.items.map((i) => ({
          id: randomUUID(),
          kind: i.kind,
          title: i.title,
          body: i.body,
          ...(endedAt(i.sessions) > 0 ? { created_at: endedAt(i.sessions) } : {}),
          refs: i.refs,
          paths: [],
          ...(sha ? { commit_sha: sha } : {}),
          ...(i.key ? { key: i.key } : {}),
          ...(i.supersedes && i.supersedes.length ? { supersedes: i.supersedes } : {}),
          provenance: JSON.stringify({ agent: `import:${[...new Set(sessions.filter((s) => i.sessions.includes(s.id)).map((s) => s.harness))].join("+") || opts.runner.name}`, user: opts.config.user ?? "", sessions: i.sessions.slice(0, 20) }),
        }));
        try {
          const out = await client(b.branch).putItems(inputs);
          uploaded.items += out.count;
          log(`  ${b.branch}: uploaded ${out.count} items${out.superseded ? `, ${out.superseded} superseded` : ""}`);
        } catch (err) {
          result.errors.push(`${b.branch}: upload failed (${err instanceof Error ? err.message : String(err)})`);
        }
      }
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

  const report = renderReport(results, unmapped, { openclaw: "keeps no transcript on disk; nothing to import", cursor: "transcript store is undocumented; only files named like transcripts under ~/.cursor are tried" });
  const reportFile = path.join(outDir, `report-${new Date(now()).toISOString().slice(0, 10)}.txt`);
  writeFileSync(reportFile, `${report}\n`, { mode: 0o600 });
  log("");
  log(report);
  log("");
  log(opts.apply ? `uploaded ${uploaded.items} items${opts.withTurns ? ` and ${uploaded.turns} turns` : ""}; proposals saved in ${outDir}` : `dry run: proposals saved in ${outDir}; run again with --apply to upload`);
  return { results, unmapped, reportFile, itemsFiles, uploaded, cancelled: false };
}
