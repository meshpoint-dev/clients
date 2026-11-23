import type { Environment, RepoContext } from "../config.js";
import { ALL_HARNESSES, discoverSessions, type DiscoverOptions, type DiscoveredSession } from "./discover.js";
import { DEFAULT_SINCE_DAYS } from "./run.js";

// After `meshpoint connect` inside a repository: say how much history is waiting to be imported.
// Header-only discovery, no model call, no upload, text only.

export const OFFER_MIN_TURNS = 6;
const SECONDS_PER_SESSION = 30;
const WORKERS = 2;

export interface OfferOptions {
  repo: RepoContext | null;
  env: Environment;
  // Name of the agent CLI that would distill, or null when none is on PATH.
  runner: string | null;
  home?: string;
  now?: () => number;
  discover?: (opts: DiscoverOptions) => DiscoveredSession[];
}

export function importOffer(opts: OfferOptions): string | null {
  if (!opts.repo) return null;
  const now = opts.now ?? Date.now;
  const since = now() - DEFAULT_SINCE_DAYS * 86_400_000;
  const discover = opts.discover ?? discoverSessions;
  const sessions = discover({ env: opts.env, ...(opts.home ? { home: opts.home } : {}), harnesses: ALL_HARNESSES, since, project: opts.repo.project, roots: [opts.repo.root] }).filter((s) => s.project === opts.repo!.project && s.endedAt >= since && s.entries.length >= OFFER_MIN_TURNS);
  if (sessions.length === 0) return null;
  const byHarness = new Map<string, number>();
  for (const s of sessions) byHarness.set(s.harness, (byHarness.get(s.harness) ?? 0) + 1);
  const first = new Date(Math.min(...sessions.map((s) => s.startedAt))).toISOString().slice(0, 10);
  const last = new Date(Math.max(...sessions.map((s) => s.endedAt))).toISOString().slice(0, 10);
  const head = `${sessions.length} past session${sessions.length === 1 ? "" : "s"} found for this repository (${[...byHarness].map(([h, n]) => `${h} ${n}`).join(", ")}), ${first} to ${last}.`;
  if (!opts.runner) return `${head}\nNo agent CLI (claude or codex) on PATH to distill them; install one, then run: meshpoint import sessions --propose`;
  const minutes = Math.ceil((sessions.length * SECONDS_PER_SESSION) / WORKERS / 60);
  return `${head}\nDistill them with your ${opts.runner} into a proposal for review: meshpoint import sessions --propose (about ${minutes} minute${minutes === 1 ? "" : "s"}).`;
}
