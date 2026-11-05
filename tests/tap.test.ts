import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runClaudeCodeTap, type TapDeps } from "../src/claude-code/tap.js";
import { FLUSH_AFTER_MS, Spool } from "../src/spool.js";

type Call = { method: string; url: string; body: any };

let dir: string;
let calls: Call[];
let clock: number;
let failCapture: boolean;

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
  it("renders the session-start inject from recall and presence", async () => {
    const out = JSON.parse(await runClaudeCodeTap(payload("SessionStart", { source: "startup" }), deps()));
    const text: string = out.hookSpecificOutput.additionalContext;
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(text).toContain("# Meshpoint: github.com--acme--web @ master");
    expect(text).toContain("- sam (agent-2, just now): src/x.ts");
    expect(text).toContain("## Last checkpoint (2m ago)\nwe were refactoring auth");
    expect(text).toContain("- [decision] Use KV: edge speed");
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
    expect(capture?.body.turns[1].paths).toEqual(["tests/a.test.ts"]);
    expect(d.spool.read("s1")).toHaveLength(0);
  });

  it("flushes at once on session end and pre-compact, with the transcript tail as checkpoint", async () => {
    const d = deps();
    await runClaudeCodeTap(payload("UserPromptSubmit", { prompt: "hi" }), d);
    await runClaudeCodeTap(payload("PreCompact", { trigger: "auto" }), d);
    const capture = calls.find((c) => c.url.includes("/v1/capture"));
    expect(capture?.body.turns).toHaveLength(1);
    expect(capture?.body.checkpoint).toContain("[assistant]\nAdded.");

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
});
