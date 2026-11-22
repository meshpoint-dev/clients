import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Item } from "@meshpoint/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { instructionFiles, itemsForFile, renderEditNotice, renderImportNudge, SessionCache } from "../src/context.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "mp-ctx-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function item(id: string, over: Partial<Item>): Item {
  return { id, branch: "master", kind: "gotcha", title: id, body: "b", created_at: 1, confirmations: 0, retracted: 0, provenance: "", refs: [], paths: [], commit_sha: "", state: "ok", verified_at: 0, stale_count: 0, key: "", superseded_by: "", confirmed_at: 0, ...over };
}

describe("edit context", () => {
  it("picks items naming the file by ref or path, of biting kinds, not dropped or locally stale, two at most, ranked", () => {
    const items = [
      item("fact", { kind: "fact", refs: ["src/a.ts"] }),
      item("todo", { kind: "todo", refs: ["src/a.ts"] }),
      item("g-old", { kind: "gotcha", refs: ["src/a.ts"], created_at: 1 }),
      item("g-new", { kind: "gotcha", refs: ["src/a.ts"], created_at: 2 }),
      item("d", { kind: "decision", paths: ["src/a.ts"] }),
      item("dropped", { kind: "decision", refs: ["src/a.ts"], state: "dropped" }),
      item("stale", { kind: "decision", refs: ["src/a.ts"] }),
      item("retracted", { kind: "decision", refs: ["src/a.ts"], retracted: 1 }),
      item("superseded", { kind: "decision", refs: ["src/a.ts"], state: "superseded", superseded_by: "d" }),
      item("other", { kind: "gotcha", refs: ["src/b.ts"] }),
    ];
    expect(itemsForFile(items, { stale: "stale" }, "src/a.ts", 10).map((i) => i.id)).toEqual(["d", "g-new"]);
    expect(itemsForFile(items, {}, "src/none.ts")).toEqual([]);
  });

  it("renders the notice with presence first and nothing when empty", () => {
    const now = 1_000_000;
    const text = renderEditNotice("src/a.ts", [item("g", { title: "Watch the lock", body: "It is held across awaits." })], [{ agent: "codex", user: "alice", branch: "feature/x", paths: ["src/a.ts"], updated_at: now - 150_000 }], now);
    expect(text).toBe("Meshpoint, src/a.ts:\n- alice's codex edited this file 2m ago on feature/x.\n- [gotcha] Watch the lock: It is held across awaits.");
    expect(renderEditNotice("src/a.ts", [], [], now)).toBe("");
  });

  it("caches recall per session, notices a file once, and nudges import once per branch", () => {
    const cache = new SessionCache(dir);
    expect(cache.loadRecall("s1")).toBeNull();
    cache.saveRecall("s1", { project: "p", branch: "master", items: [item("x", {})], verdicts: { x: "verified" }, at: 1 });
    expect(cache.loadRecall("s1")?.items.map((i) => i.id)).toEqual(["x"]);
    expect(cache.firstEdit("s1", "src/a.ts")).toBe(true);
    expect(cache.firstEdit("s1", "src/a.ts")).toBe(false);
    expect(cache.firstEdit("s1", "src/b.ts")).toBe(true);
    expect(cache.firstEdit("s2", "src/a.ts")).toBe(true);
    cache.forget("s1");
    expect(cache.loadRecall("s1")).toBeNull();
    expect(cache.firstEdit("s1", "src/a.ts")).toBe(true);
    expect(cache.firstImportNudge("p", "master")).toBe(true);
    expect(cache.firstImportNudge("p", "master")).toBe(false);
    expect(cache.firstImportNudge("p", "feature")).toBe(true);
  });

  it("lists tracked instruction files and renders the nudge", () => {
    expect(instructionFiles(() => "CLAUDE.md\n.cursor/rules/testing.mdc\n\n")).toEqual(["CLAUDE.md", ".cursor/rules/testing.mdc"]);
    expect(instructionFiles(() => null)).toEqual([]);
    expect(instructionFiles(() => "")).toEqual([]);
    expect(renderImportNudge(["CLAUDE.md"])).toContain("Run the meshpoint-import skill once");
  });
});
