import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runClaudeCodeTap, type TapDeps } from "../src/claude-code/tap.js";
import { CHECKPOINT_TURNS, Checkpoints } from "../src/checkpoints.js";
import { SessionCache } from "../src/context.js";
import { FLUSH_AFTER_MS, Spool } from "../src/spool.js";
import type { LocalChecks } from "../src/tap.js";
import { Touched } from "../src/touched.js";

type Call = { method: string; url: string; body: any };

let dir: string;
let calls: Call[];
let clock: number;
let failCapture: boolean;

const stamp = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const replies = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    [
      JSON.stringify({ type: "user", timestamp: stamp((i - n) * 1000), message: { content: `prompt ${i}` } }),
      JSON.stringify({ type: "assistant", timestamp: stamp((i - n) * 1000 + 500), message: { content: [{ type: "text", text: `reply ${i}` }] } }),
    ].join("\n"),
  ).join("\n");

function deps(over: Partial<TapDeps> = {}): TapDeps {
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method: init?.method ?? "GET", url, body });
    if (url.includes("/v1/recall")) {
      return Response.json({
        project: "p",
        branch: "master",
        checkpoint: { body: "we were refactoring auth", created_at: clock - 120_000 },
        items: [{ id: "d1", kind: "decision", title: "Use KV", body: "edge speed", branch: "master", created_at: 1, confirmations: 0, retracted: 0, provenance: "" }],
        generated_at: clock,
        source: "kv",
      });
    }
    if (url.includes("/v1/presence")) {
      return Response.json({ presence: [{ agent: "agent-2", user: "sam", branch: "master", paths: ["src/x.ts"], updated_at: clock - 30_000 }] });
    }
    if (url.includes("/v1/capture") && failCapture) return Response.json({ error: "down" }, { status: 503 });
    return Response.json({ accepted: 1 }, { status: 202 });
  });
  return {
    config: { baseUrl: "https://api.test", token: "tok" },
    repo: () => ({ project: "github.com--acme--web", branch: "master", root: "/repo" }),
    readTranscript: () =>
      [
        JSON.stringify({ type: "user", message: { content: "add tests" } }),
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Added." }, { type: "tool_use", input: { file_path: "/repo/tests/a.test.ts" } }] } }),
      ].join("\n"),
    spool: new Spool(dir),
    checkpoints: new Checkpoints(dir),
    now: () => clock,
    fetch: fetchImpl as unknown as typeof fetch,
    presenceWaitMs: 50,
    ...over,
  };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "mp-spool-"));
  calls = [];
  clock = 1_700_000_000_000;
  failCapture = false;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const payload = (hook_event_name: string, extra: Record<string, unknown> = {}) => ({
  hook_event_name,
  session_id: "s1",
  transcript_path: "/tmp/t.jsonl",
  cwd: "/repo",
  ...extra,
});

describe("claude code tap", () => {
  it("refreshes once after a 401 and retries the inject and the flush", async () => {
    const seen: Array<{ url: string; token: string | undefined }> = [];
    const gated = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const token = (init?.headers as Record<string, string> | undefined)?.authorization?.replace("Bearer ", "");
      seen.push({ url: String(input), token });
      if (token !== "tok2") return Response.json({ error: "unauthorized" }, { status: 401 });
      if (String(input).includes("/v1/recall")) return Response.json({ project: "p", branch: "master", checkpoint: null, items: [], generated_at: clock, source: "kv" });
      if (String(input).includes("/v1/presence")) return Response.json({ presence: [{ agent: "a2", user: "sam", branch: "master", paths: [], updated_at: clock }] });
      return Response.json({ accepted: 1 }, { status: 202 });
    });
    const refresh = vi.fn(async () => ({ baseUrl: "https://api.test", token: "tok2" }));
    const d = deps({ fetch: gated as unknown as typeof fetch, refresh });
    const start = await runClaudeCodeTap(payload("SessionStart"), d);
    expect(start).toContain("sam");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(seen.filter((c) => c.url.includes("/v1/recall")).map((c) => c.token)).toEqual(["tok", "tok2"]);

    // A fresh tap (new process) still holds the old token: the flush path refreshes too.
    const d2 = deps({ fetch: gated as unknown as typeof fetch, refresh });
    await runClaudeCodeTap(payload("UserPromptSubmit", { prompt: "hi" }), d2);
    clock += FLUSH_AFTER_MS + 1;
    await runClaudeCodeTap(payload("SessionEnd"), d2);
    const captures = seen.filter((c) => c.url.includes("/v1/capture")).map((c) => c.token);
    expect(captures).toEqual(["tok", "tok2"]);
    expect(new Spool(dir).take("s1").turns).toHaveLength(0);

    // No refresh available: the hook still degrades to the empty answer.
    const d3 = deps({ fetch: gated as unknown as typeof fetch });
    expect(await runClaudeCodeTap(payload("SessionStart"), d3)).toBe("{}");
  });

  it("renders the session-start inject from recall and presence", async () => {
    const out = JSON.parse(await runClaudeCodeTap(payload("SessionStart", { source: "startup" }), deps()));
    const text: string = out.hookSpecificOutput.additionalContext;
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(text).toContain("# Meshpoint: github.com--acme--web @ master");
    expect(text).toContain("- sam (agent-2, just now): src/x.ts");
    expect(text).toContain("## Last checkpoint (2m ago)\nwe were refactoring auth");
    expect(text).toContain("- d1 [decision] Use KV: edge speed");
  });

  it("asks for the whole branch, verifies locally, marks suspect, lists stale, reports sightings, caches for edits", async () => {
    const items = [
      { id: "d1aaaaaa", kind: "decision", title: "Use KV", body: "edge speed", branch: "master", created_at: 3, confirmations: 0, retracted: 0, provenance: "", refs: ["src/kv.ts"], paths: [], commit_sha: "", state: "ok", verified_at: 0, stale_count: 0 },
      { id: "g1aaaaaa", kind: "gotcha", title: "Lock order", body: "a before b", branch: "master", created_at: 2, confirmations: 0, retracted: 0, provenance: "", refs: ["src/lock.ts"], paths: [], commit_sha: "", state: "ok", verified_at: 0, stale_count: 0 },
      { id: "f1aaaaaa", kind: "fact", title: "Node 22", body: "ci pins it", branch: "master", created_at: 1, confirmations: 0, retracted: 0, provenance: "", refs: ["ci.yml"], paths: [], commit_sha: "", state: "ok", verified_at: 0, stale_count: 0 },
      { id: "s1aaaaaa", kind: "fact", title: "Server says suspect", body: "x", branch: "master", created_at: 1, confirmations: 0, retracted: 0, provenance: "", refs: [], paths: [], commit_sha: "", state: "suspect", verified_at: 0, stale_count: 0 },
      // Left out: an old todo nobody confirmed, and an item a newer one replaced, even if a cached blob carries them.
      { id: "t0aaaaaa", kind: "todo", title: "Old todo", body: "x", branch: "master", created_at: 1, confirmations: 0, retracted: 0, provenance: "", refs: [], paths: [], commit_sha: "", state: "ok", verified_at: 0, stale_count: 0, confirmed_at: 0 },
      { id: "r0aaaaaa", kind: "decision", title: "Replaced", body: "x", branch: "master", created_at: 1, confirmations: 0, retracted: 0, provenance: "", refs: [], paths: [], commit_sha: "", state: "superseded", superseded_by: "d1aaaaaa", verified_at: 0, stale_count: 0 },
    ];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (url.includes("/v1/recall")) return Response.json({ project: "p", branch: "master", checkpoint: null, items, generated_at: clock, source: "kv" });
      if (url.includes("/v1/presence")) return Response.json({ presence: [] });
      return Response.json({ applied: 3 }, { status: 202 });
    });
    const local: LocalChecks = {
      verify: (seen) => new Map(seen.map((i) => [i.id, i.id.startsWith("d1") ? "verified" : i.id.startsWith("g1") ? "suspect" : i.id.startsWith("f1") ? "stale" : "skipped"])),
      instructionFiles: () => ["CLAUDE.md"],
    };
    const cache = new SessionCache(dir);
    const d = deps({ fetch: fetchImpl as unknown as typeof fetch, local: () => local, cache });
    const out = JSON.parse(await runClaudeCodeTap(payload("SessionStart"), d));
    const text: string = out.hookSpecificOutput.additionalContext;
    expect(calls.find((c) => c.url.includes("/v1/recall"))?.url).toContain("budget=100000");
    expect(text).toContain("## Team knowledge (3; first column is the item id, ? means a referenced file changed since)");
    expect(text).toContain("- d1aaaaaa [decision] Use KV: edge speed");
    expect(text).toContain("- g1aaaaaa? [gotcha] Lock order: a before b");
    expect(text).toContain("- s1aaaaaa? [fact] Server says suspect: x");
    expect(text).toContain("## Possibly stale (a referenced file is gone; verify, then retract or rewrite)\n- f1aaaaaa [fact] Node 22");
    expect(text).not.toContain("Node 22: ci pins it");
    expect(text).not.toContain("Old todo");
    expect(text).not.toContain("Replaced");
    // No import nudge: the branch has items.
    expect(text).not.toContain("meshpoint-import");
    const verify = calls.find((c) => c.url.endsWith("/v1/items/verify"));
    expect(verify?.body.sightings).toEqual([
      { id: "d1aaaaaa", result: "verified" },
      { id: "g1aaaaaa", result: "suspect" },
      { id: "f1aaaaaa", result: "stale" },
    ]);
    expect(cache.loadRecall("s1")).toMatchObject({ project: "github.com--acme--web", branch: "master", verdicts: { d1aaaaaa: "verified", f1aaaaaa: "stale" } });
    expect(cache.loadRecall("s1")?.items).toHaveLength(6);

    // The edit hook: cached items for the file (not the stale one), presence from the origin, once per file.
    fetchImpl.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      calls.push({ method: "GET", url, body: undefined });
      return Response.json({ items: [], presence: [{ agent: "codex", user: "alice", branch: "feature/x", paths: ["src/lock.ts"], updated_at: clock - 60_000 }] });
    });
    const edit = JSON.parse(await runClaudeCodeTap(payload("PreToolUse", { tool_name: "Edit", tool_input: { file_path: "/repo/src/lock.ts" } }), d));
    expect(edit.hookSpecificOutput).toEqual({
      hookEventName: "PreToolUse",
      additionalContext: "Meshpoint, src/lock.ts:\n- alice's codex edited this file 1m ago on feature/x.\n- [gotcha] Lock order: a before b",
    });
    expect(calls.at(-1)?.url).toContain("/v1/context?project=github.com--acme--web&branch=master&path=src%2Flock.ts");
    expect(await runClaudeCodeTap(payload("PreToolUse", { tool_name: "Edit", tool_input: { file_path: "/repo/src/lock.ts" } }), d)).toBe("{}");
    expect(await runClaudeCodeTap(payload("PreToolUse", { tool_name: "Write", tool_input: { file_path: "/elsewhere/x.ts" } }), d)).toBe("{}");
    // Codex: files come out of the patch body.
    const patch = "*** Begin Patch\n*** Update File: src/kv.ts\n@@\n-a\n+b\n*** End Patch";
    const codex = JSON.parse(await runClaudeCodeTap(payload("PreToolUse", { tool_name: "apply_patch", tool_input: { command: patch } }), d));
    expect(codex.hookSpecificOutput.additionalContext).toContain("[decision] Use KV: edge speed");
  });

  it("nudges an import once on an empty branch with committed instruction files, and records touched paths on Stop", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (url.includes("/v1/recall")) return Response.json({ project: "p", branch: "master", checkpoint: null, items: [], generated_at: clock, source: "none" });
      if (url.includes("/v1/presence")) return Response.json({ presence: [] });
      return Response.json({ accepted: 1 }, { status: 202 });
    });
    const local: LocalChecks = { verify: () => new Map(), instructionFiles: () => ["CLAUDE.md", ".cursor/rules/testing.mdc"] };
    const touched = new Touched(dir);
    const d = deps({ fetch: fetchImpl as unknown as typeof fetch, local: () => local, cache: new SessionCache(dir), touched });
    const first = JSON.parse(await runClaudeCodeTap(payload("SessionStart"), d)).hookSpecificOutput.additionalContext as string;
    expect(first).toBe("# Meshpoint: github.com--acme--web @ master\n\nThis branch has no team knowledge yet.\nInstruction files found: CLAUDE.md, .cursor/rules/testing.mdc.\nRun the meshpoint-import skill once to seed items from them, then continue.");
    expect(await runClaudeCodeTap(payload("SessionStart", { session_id: "s2" }), d)).toBe("{}");
    expect(calls.some((c) => c.url.endsWith("/v1/items/verify"))).toBe(false);

    await runClaudeCodeTap(payload("Stop"), d);
    expect(touched.since("github.com--acme--web", "master", 0)).toEqual(["tests/a.test.ts"]);
  });

  it("spools prompt and reply turns and sends them once the spool is 60s old", async () => {
    const d = deps();
    expect(await runClaudeCodeTap(payload("UserPromptSubmit", { prompt: "add tests" }), d)).toBe("{}");
    expect(await runClaudeCodeTap(payload("Stop"), d)).toBe('{"decision":"continue"}');
    expect(calls.filter((c) => c.url.includes("/v1/capture"))).toHaveLength(0);
    expect(d.spool.read("s1")).toHaveLength(2);

    clock += FLUSH_AFTER_MS;
    await runClaudeCodeTap(payload("UserPromptSubmit", { prompt: "and docs" }), d);
    const capture = calls.find((c) => c.url.includes("/v1/capture"));
    expect(capture?.body.turns.map((t: { body: string }) => t.body)).toEqual(["[user] add tests", "[assistant] Added.", "[user] and docs"]);
    expect(capture?.body.session).toBe("s1");
    expect(capture?.body.turns[1].paths).toEqual(["tests/a.test.ts"]);
    expect(d.spool.read("s1")).toHaveLength(0);
  });

  it("masks credentials before the turn reaches the spool file", async () => {
    const d = deps();
    await runClaudeCodeTap(payload("UserPromptSubmit", { prompt: "use ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij12 and DATABASE_URL=postgres://app:s3cretpass@db/x" }), d);
    const spooled = d.spool.read("s1");
    expect(spooled[0]?.body).toBe("[user] use [REDACTED:github-token] and DATABASE_URL=postgres://app:[REDACTED:url-password]@db/x");
    expect(JSON.stringify(spooled)).not.toMatch(/ghp_|s3cretpass/);
  });

  it("flushes at once on session end and pre-compact, without a checkpoint body", async () => {
    const d = deps();
    await runClaudeCodeTap(payload("UserPromptSubmit", { prompt: "hi" }), d);
    await runClaudeCodeTap(payload("PreCompact", { trigger: "auto" }), d);
    const capture = calls.find((c) => c.url.includes("/v1/capture"));
    expect(capture?.body.turns).toHaveLength(1);
    expect(capture?.body.checkpoint).toBeUndefined();

    await runClaudeCodeTap(payload("UserPromptSubmit", { prompt: "bye" }), d);
    expect(await runClaudeCodeTap(payload("SessionEnd", { reason: "exit" }), d)).toBe("{}");
    expect(calls.filter((c) => c.url.includes("/v1/capture"))).toHaveLength(2);
  });

  it("keeps the spool when the platform is down and never throws", async () => {
    const d = deps();
    failCapture = true;
    await runClaudeCodeTap(payload("UserPromptSubmit", { prompt: "hi" }), d);
    expect(await runClaudeCodeTap(payload("SessionEnd"), d)).toBe("{}");
    expect(d.spool.read("s1").map((t) => t.body)).toEqual(["[user] hi"]);
  });

  it("does nothing outside a repo with an origin remote", async () => {
    const d = deps({ repo: () => null });
    expect(await runClaudeCodeTap(payload("SessionStart"), d)).toBe("{}");
    expect(await runClaudeCodeTap(payload("Stop"), d)).toBe('{"decision":"continue"}');
    expect(calls).toHaveLength(0);
  });

  it("nudges a checkpoint once enough replies pile up, then not again until the next pile", async () => {
    const d = deps({ readTranscript: () => replies(CHECKPOINT_TURNS) });
    const out = JSON.parse(await runClaudeCodeTap(payload("Stop"), d));
    expect(out.decision).toBe("block");
    expect(out.reason).toContain("meshpoint");
    // The continuation Stop and every Stop after it pass until the counter refills.
    expect(await runClaudeCodeTap(payload("Stop", { stop_hook_active: true }), d)).toBe('{"decision":"continue"}');
    expect(await runClaudeCodeTap(payload("Stop"), d)).toBe('{"decision":"continue"}');
  });

  it("counts replies only after the branch's last checkpoint", async () => {
    const d = deps({ readTranscript: () => replies(CHECKPOINT_TURNS + 5) });
    d.checkpoints.markCheckpoint("github.com--acme--web", "master", clock - 1);
    expect(await runClaudeCodeTap(payload("Stop"), d)).toBe('{"decision":"continue"}');
    d.checkpoints.markCheckpoint("github.com--acme--web", "master", clock - 60_000);
    expect(JSON.parse(await runClaudeCodeTap(payload("Stop"), d)).decision).toBe("block");
  });
});
