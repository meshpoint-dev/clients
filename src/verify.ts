import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Item, SightingResult } from "@meshpoint/sdk";

// Deterministic verification of items against the checkout, with no model: every ref must still
// exist, and git log says whether any ref changed after the item was written. A checkout that
// does not contain the item's commit is older than the item and cannot judge it.
export type Verdict = SightingResult | "skipped";

export interface Git {
  // Runs git in the repo root; null on a non-zero exit or a failure to run.
  (args: string[]): string | null;
}

export interface VerifyOptions {
  git?: Git;
  exists?: (abs: string) => boolean;
  now?: () => number;
  // Wall-clock budget for the whole pass; items past it are left unverified.
  budgetMs?: number;
}

export const VERIFY_BUDGET_MS = 2000;

export function gitRunner(root: string): Git {
  return (args) => {
    try {
      return execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).toString();
    } catch {
      return null;
    }
  };
}

export function verifyItems(items: readonly Item[], root: string, opts: VerifyOptions = {}): Map<string, Verdict> {
  const git = opts.git ?? gitRunner(root);
  const exists = opts.exists ?? existsSync;
  const now = opts.now ?? Date.now;
  const started = now();
  const out = new Map<string, Verdict>();
  let headKnown: boolean | null = null;
  for (const item of items) {
    if (item.retracted || item.refs.length === 0) continue;
    if (now() - started > (opts.budgetMs ?? VERIFY_BUDGET_MS)) break;
    if (item.commit_sha) {
      if (headKnown === null) headKnown = git(["rev-parse", "HEAD"]) !== null;
      if (headKnown && git(["merge-base", "--is-ancestor", item.commit_sha, "HEAD"]) === null) {
        out.set(item.id, "skipped");
        continue;
      }
    }
    if (item.refs.some((ref) => !exists(path.join(root, ref)))) {
      out.set(item.id, "stale");
      continue;
    }
    const since = new Date(item.created_at).toISOString();
    const log = git(["log", "-1", "--format=%H", `--since=${since}`, "--", ...item.refs]);
    out.set(item.id, log === null || log.trim() === "" ? "verified" : "suspect");
  }
  return out;
}

// Only real verdicts travel to the platform.
export function sightings(verdicts: ReadonlyMap<string, Verdict>): Array<{ id: string; result: SightingResult }> {
  const out: Array<{ id: string; result: SightingResult }> = [];
  for (const [id, result] of verdicts) if (result !== "skipped") out.push({ id, result });
  return out;
}
