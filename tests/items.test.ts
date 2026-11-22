import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Checkpoints } from "../src/checkpoints.js";
import { confirmItems, parseItemArgs, parseItems, putItems, retractItems } from "../src/items.js";
import { Touched } from "../src/touched.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "mp-items-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("items put", () => {
  it("rejects anything but a non-empty array of known kinds", () => {
    expect(() => parseItems("nope")).toThrow(/JSON array/);
    expect(() => parseItems("[]")).toThrow(/non-empty/);
    expect(() => parseItems('[{"kind":"rumor","title":"x","body":"y"}]')).toThrow(/kind must be one of/);
    expect(() => parseItems('[{"kind":"fact","title":"","body":"y"}]')).toThrow(/title required/);
    expect(parseItems('[{"kind":"fact","title":" T ","body":"B"}]')).toEqual([{ kind: "fact", title: "T", body: "B" }]);
  });

  it("takes repeated --item kind title body arguments", () => {
    expect(parseItemArgs(["--item", "gotcha", "T1", "B1", "--item", "todo", "T2", "B2"])).toEqual([
      { kind: "gotcha", title: "T1", body: "B1" },
      { kind: "todo", title: "T2", body: "B2" },
    ]);
    expect(() => parseItemArgs(["--item", "gotcha", "T1"])).toThrow(/body required/);
    expect(() => parseItemArgs(["--bogus"])).toThrow(/unexpected argument/);
  });

  it("posts items with fresh ids and records the branch checkpoint", async () => {
    const calls: { url: string; body: any }[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(init?.body as string) });
      return Response.json({ count: 2 }, { status: 202 });
    });
    const checkpoints = new Checkpoints(dir);
    checkpoints.markCheckpoint("github.com--acme--web", "master", 10);
    const touched = new Touched(dir);
    touched.append("github.com--acme--web", "master", ["src/old.ts"], 5);
    touched.append("github.com--acme--web", "master", ["src/recall.ts", "src/kv.ts"], 20);
    const existing = new Set(["/repo/src/recall.ts", "/repo/package.json"]);
    const out = await putItems(
      [
        { kind: "decision", title: "Use KV for recall", body: "Served from the edge; see src/recall.ts and `package.json`. Not src/missing.ts." },
        { kind: "todo", title: "Add tests", body: "for recall" },
      ],
      {
        config: { baseUrl: "https://api.test", token: "tok" },
        repo: { project: "github.com--acme--web", branch: "master", root: "/repo" },
        checkpoints,
        touched,
        now: () => 42,
        fetch: fetchImpl as unknown as typeof fetch,
        exists: (p) => existing.has(p),
        sha: () => "c".repeat(40),
      },
    );
    expect(out).toEqual({ count: 2, missing: ["src/missing.ts"] });
    expect(calls[0]?.url).toBe("https://api.test/v1/items");
    expect(calls[0]?.body.items.map((i: { id: string }) => i.id)).toHaveLength(2);
    // Refs come from the text; paths are what was edited since the last checkpoint (not src/old.ts).
    expect(calls[0]?.body.items[0]).toMatchObject({ kind: "decision", refs: ["package.json", "src/recall.ts"], paths: ["src/recall.ts", "src/kv.ts"], commit_sha: "c".repeat(40) });
    expect(calls[0]?.body.items[1]).toMatchObject({ kind: "todo", refs: [], paths: ["src/recall.ts", "src/kv.ts"] });
    expect(checkpoints.lastCheckpoint("github.com--acme--web", "master")).toBe(42);
    expect(touched.since("github.com--acme--web", "master", 0)).toEqual([]);
  });

  it("omits commit_sha outside git and confirms by prefix", async () => {
    const calls: { url: string; body: any }[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (url.includes("/v1/recall")) return Response.json({ project: "p", branch: "master", checkpoint: null, items: [{ id: "abcd1234-x" }], generated_at: 1, source: "do" });
      return Response.json({ count: 1, found: true }, { status: 202 });
    });
    const deps = { config: { baseUrl: "https://api.test", token: "tok" }, repo: { project: "p", branch: "master", root: "/repo" }, fetch: fetchImpl as unknown as typeof fetch };
    await putItems([{ kind: "fact", title: "t", body: "b" }], { ...deps, checkpoints: new Checkpoints(dir), exists: () => false, sha: () => "" });
    expect(calls[0]?.body.items[0]).not.toHaveProperty("commit_sha");
    expect(calls[0]?.body.items[0]).toMatchObject({ refs: [], paths: [] });
    expect(await confirmItems(["abcd"], deps)).toEqual({ confirmed: ["abcd1234-x"] });
    expect(calls.at(-1)).toMatchObject({ url: "https://api.test/v1/items/confirm", body: { project: "p", id: "abcd1234-x" } });
  });

  it("retracts by unique id prefix against the branch's live items", async () => {
    const calls: { url: string; body: any }[] = [];
    const items = ["aaaa1111-x", "aaaa2222-y", "bbbb3333-z"].map((id) => ({ id, kind: "todo", title: id, body: "b", branch: "master", created_at: 1, confirmations: 0, retracted: 0, provenance: "" }));
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (url.includes("/v1/recall")) return Response.json({ project: "p", branch: "master", checkpoint: null, items, generated_at: 1, source: "do" });
      return Response.json({ found: true }, { status: 202 });
    });
    const deps = { config: { baseUrl: "https://api.test", token: "tok" }, repo: { project: "p", branch: "master", root: "/repo" }, fetch: fetchImpl as unknown as typeof fetch };
    await expect(retractItems(["aaaa"], deps)).rejects.toThrow(/matches 2 items/);
    await expect(retractItems(["cccc"], deps)).rejects.toThrow(/no item on master/);
    expect(await retractItems(["aaaa1", "bbbb"], deps)).toEqual({ retracted: ["aaaa1111-x", "bbbb3333-z"] });
    expect(calls[0]?.url).toContain("fresh=1");
    expect(calls.filter((c) => c.url.endsWith("/v1/retract")).map((c) => c.body.id)).toEqual(["aaaa1111-x", "bbbb3333-z"]);
  });
});
