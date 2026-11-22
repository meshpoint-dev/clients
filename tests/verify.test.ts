import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Item } from "@meshpoint/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitRunner, sightings, verifyItems } from "../src/verify.js";

let root: string;
// Commits are dated explicitly: the first one predates every item, the second follows them.
let commitDate = "2025-12-31T00:00:00Z";
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GIT_AUTHOR_DATE: commitDate, GIT_COMMITTER_DATE: commitDate } }).toString().trim();

function item(id: string, over: Partial<Item>): Item {
  return { id, branch: "master", kind: "fact", title: id, body: "b", created_at: Date.parse("2026-01-01T00:00:00Z"), confirmations: 0, retracted: 0, provenance: "", refs: [], paths: [], commit_sha: "", state: "ok", verified_at: 0, stale_count: 0, ...over };
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "mp-verify-"));
  commitDate = "2025-12-31T00:00:00Z";
  git("init", "-q", "-b", "master");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src/a.ts"), "a");
  writeFileSync(path.join(root, "src/b.ts"), "b");
  git("add", ".");
  git("commit", "-q", "-m", "first");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("verifyItems", () => {
  it("classifies present and untouched, changed since, and missing refs; skips items from a newer commit and items without refs", () => {
    const first = git("rev-parse", "HEAD");
    commitDate = "2026-01-02T00:00:00Z";
    writeFileSync(path.join(root, "src/b.ts"), "b2");
    git("add", ".");
    git("commit", "-q", "-m", "second");
    const items = [
      item("ok", { refs: ["src/a.ts"], commit_sha: first }),
      item("changed", { refs: ["src/a.ts", "src/b.ts"], commit_sha: first }),
      item("gone", { refs: ["src/zzz.ts"] }),
      item("future", { refs: ["src/a.ts"], commit_sha: "f".repeat(40) }),
      item("norefs", {}),
      item("retracted", { refs: ["src/zzz.ts"], retracted: 1 }),
      // Written after the second commit: nothing changed since, so verified.
      item("recent", { refs: ["src/b.ts"], created_at: Date.parse("2026-01-03T00:00:00Z") }),
    ];
    const verdicts = verifyItems(items, root, { git: gitRunner(root) });
    expect(Object.fromEntries(verdicts)).toEqual({ ok: "verified", changed: "suspect", gone: "stale", future: "skipped", recent: "verified" });
    expect(sightings(verdicts)).toEqual([
      { id: "ok", result: "verified" },
      { id: "changed", result: "suspect" },
      { id: "gone", result: "stale" },
      { id: "recent", result: "verified" },
    ]);
  });

  it("stops at the time budget and treats a missing git as no history", () => {
    let t = 0;
    const items = [item("a", { refs: ["src/a.ts"] }), item("b", { refs: ["src/b.ts"] })];
    const verdicts = verifyItems(items, root, { git: gitRunner(root), now: () => (t += 1500), budgetMs: 2000 });
    expect([...verdicts.keys()]).toEqual(["a"]);
    expect(Object.fromEntries(verifyItems(items, root, { git: () => null }))).toEqual({ a: "verified", b: "verified" });
  });
});
