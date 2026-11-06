import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Checkpoints } from "../src/checkpoints.js";
import { parseItemArgs, parseItems, putItems, retractItems } from "../src/items.js";

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
    const out = await putItems(
      [
        { kind: "decision", title: "Use KV", body: "edge speed" },
        { kind: "todo", title: "Add tests", body: "for recall" },
      ],
      {
        config: { baseUrl: "https://api.test", token: "tok" },
        repo: { project: "github.com--acme--web", branch: "master", root: "/repo" },
        checkpoints,
        now: () => 42,
        fetch: fetchImpl as unknown as typeof fetch,
      },
    );
    expect(out).toEqual({ count: 2 });
    expect(calls[0]?.url).toBe("https://api.test/v1/items");
    expect(calls[0]?.body.items.map((i: { id: string }) => i.id)).toHaveLength(2);
    expect(calls[0]?.body.items[0]).toMatchObject({ kind: "decision", title: "Use KV", body: "edge speed" });
    expect(checkpoints.lastCheckpoint("github.com--acme--web", "master")).toBe(42);
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
