import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TapDeps } from "../src/claude-code/tap.js";
import { lastAssistantTurn } from "../src/claude-code/transcript.js";
import { CHECKPOINT_TURNS, Checkpoints } from "../src/checkpoints.js";
import { connectCursor, CURSOR_EVENTS, CURSOR_TAP_COMMAND, cursorPaths } from "../src/cursor/connect.js";
import { runCursorTap } from "../src/cursor/tap.js";
import { parseCursorTranscript } from "../src/cursor/transcript.js";
import { FLUSH_AFTER_MS, Spool } from "../src/spool.js";

type Call = { method: string; url: string; body: any };

let dir: string;
let calls: Call[];
let clock: number;

const line = (o: unknown) => JSON.stringify(o);
const stamp = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const replies = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    [
      line({ type: "user", timestamp: stamp((i - n) * 1000), message: { content: `prompt ${i}` } }),
      line({ type: "assistant", timestamp: stamp((i - n) * 1000 + 500), message: { content: [{ type: "text", text: `reply ${i}` }] } }),
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
    if (url.includes("/v1/context")) {
      return Response.json({ items: [{ id: "g1", kind: "gotcha", title: "Mind the lock", body: "held across awaits", branch: "master", created_at: 1, confirmations: 0, retracted: 0, provenance: "", refs: ["src/x.ts"], paths: [], commit_sha: "", state: "ok", verified_at: 0, stale_count: 0 }], presence: [] });
    }
    return Response.json({ accepted: 1 }, { status: 202 });
  });
  return {
    config: { baseUrl: "https://api.test", token: "tok" },
    repo: () => ({ project: "github.com--acme--web", branch: "master", root: "/repo" }),
    readTranscript: () =>
      [
        line({ type: "user", message: { content: "add tests" } }),
        line({ type: "assistant", message: { content: [{ type: "text", text: "Added." }, { type: "tool_use", input: { file_path: "/repo/tests/a.test.ts" } }] } }),
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
  dir = mkdtempSync(path.join(tmpdir(), "mp-cursor-"));
  calls = [];
  clock = 1_700_000_000_000;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// The common input fields every Cursor hook receives (docs: Reference, "Common schema").
const payload = (hook_event_name: string, extra: Record<string, unknown> = {}) => ({
  hook_event_name,
  conversation_id: "c1",
  generation_id: "g1",
  model: "m",
  cursor_version: "2.4.0",
  workspace_roots: ["/repo"],
  user_email: null,
  transcript_path: "/tmp/t.jsonl",
  ...extra,
});

describe("cursor tap", () => {
  it("renders the session-start inject as additional_context", async () => {
    const out = JSON.parse(await runCursorTap(payload("sessionStart", { session_id: "c1", is_background_agent: false, composer_mode: "agent" }), deps()));
    expect(Object.keys(out)).toEqual(["additional_context"]);
    const text: string = out.additional_context;
    expect(text).toContain("# Meshpoint: github.com--acme--web @ master");
    expect(text).toContain("- sam (agent-2, just now): src/x.ts");
    expect(text).toContain("## Last checkpoint (2m ago)\nwe were refactoring auth");
    expect(text).toContain("- d1 [decision] Use KV: edge speed");
  });

  it("lets every prompt through, spools it under the conversation id, and skips its own nudge echo", async () => {
    const d = deps();
    expect(await runCursorTap(payload("beforeSubmitPrompt", { prompt: "add tests", attachments: [] }), d)).toBe('{"continue":true}');
    expect(await runCursorTap(payload("beforeSubmitPrompt", { prompt: "Meshpoint checkpoint due (20 replies since the last one). Run the meshpoint skill now, then continue." }), d)).toBe('{"continue":true}');
    expect(d.spool.read("c1").map((t) => t.body)).toEqual(["[user] add tests"]);
  });

  it("answers postToolUse on a file edit with the file notice as additional_context", async () => {
    const d = deps();
    const out = JSON.parse(await runCursorTap(payload("postToolUse", { tool_name: "edit_file", tool_input: { file_path: "/repo/src/x.ts" } }), d));
    expect(out).toEqual({ additional_context: "Meshpoint, src/x.ts:\n- [gotcha] Mind the lock: held across awaits" });
    expect(calls.at(-1)?.url).toContain("/v1/context?project=github.com--acme--web&branch=master&path=src%2Fx.ts");
    expect(await runCursorTap(payload("postToolUse", { tool_name: "shell", tool_input: { command: "ls" } }), d)).toBe("{}");
  });

  it("captures the reply from afterAgentResponse with the transcript's touched paths, then sends after 60s", async () => {
    const d = deps();
    await runCursorTap(payload("beforeSubmitPrompt", { prompt: "add tests" }), d);
    expect(await runCursorTap(payload("afterAgentResponse", { text: "Added." }), d)).toBe("{}");
    expect(await runCursorTap(payload("stop", { status: "completed", loop_count: 0 }), d)).toBe("{}");
    expect(calls.filter((c) => c.url.includes("/v1/capture"))).toHaveLength(0);

    clock += FLUSH_AFTER_MS;
    await runCursorTap(payload("beforeSubmitPrompt", { prompt: "and docs" }), d);
    const capture = calls.find((c) => c.url.includes("/v1/capture"));
    expect(capture?.body.turns.map((t: { body: string }) => t.body)).toEqual(["[user] add tests", "[assistant] Added.", "[user] and docs"]);
    expect(capture?.body.turns[1].paths).toEqual(["tests/a.test.ts"]);
    expect(d.spool.read("c1")).toHaveLength(0);
  });

  it("still captures the reply text when the transcript is missing or unreadable", async () => {
    const d = deps({
      readTranscript: () => {
        throw new Error("gone");
      },
    });
    await runCursorTap(payload("afterAgentResponse", { text: "Done." }), d);
    await runCursorTap(payload("afterAgentResponse", { text: "Again.", transcript_path: null }), d);
    expect(d.spool.read("c1").map((t) => [t.body, t.paths])).toEqual([["[assistant] Done.", undefined], ["[assistant] Again.", undefined]]);
  });

  it("flushes at once on preCompact and sessionEnd", async () => {
    const d = deps();
    await runCursorTap(payload("beforeSubmitPrompt", { prompt: "hi" }), d);
    expect(await runCursorTap(payload("preCompact", { trigger: "auto", context_usage_percent: 85 }), d)).toBe("{}");
    expect(calls.filter((c) => c.url.includes("/v1/capture"))).toHaveLength(1);
    await runCursorTap(payload("beforeSubmitPrompt", { prompt: "bye" }), d);
    expect(await runCursorTap(payload("sessionEnd", { session_id: "c1", reason: "user_close", duration_ms: 1000 }), d)).toBe("{}");
    expect(calls.filter((c) => c.url.includes("/v1/capture"))).toHaveLength(2);
  });

  it("nudges through followup_message once enough replies pile up, only on completed stops, and not twice", async () => {
    const d = deps({ readTranscript: () => replies(CHECKPOINT_TURNS) });
    expect(await runCursorTap(payload("stop", { status: "aborted", loop_count: 0 }), d)).toBe("{}");
    const out = JSON.parse(await runCursorTap(payload("stop", { status: "completed", loop_count: 0 }), d));
    expect(Object.keys(out)).toEqual(["followup_message"]);
    expect(out.followup_message).toContain("Run the meshpoint skill now");
    // The follow-up's own stop, and every stop after it, pass until the counter refills.
    expect(await runCursorTap(payload("stop", { status: "completed", loop_count: 1 }), d)).toBe("{}");
    expect(await runCursorTap(payload("stop", { status: "completed", loop_count: 1 }), d)).toBe("{}");
  });

  it("does nothing outside a repo with an origin remote, and ignores events it does not manage", async () => {
    const d = deps({ repo: () => null });
    expect(await runCursorTap(payload("sessionStart"), d)).toBe("{}");
    expect(await runCursorTap(payload("beforeSubmitPrompt", { prompt: "hi" }), d)).toBe('{"continue":true}');
    expect(await runCursorTap(payload("stop", { status: "completed" }), d)).toBe("{}");
    expect(await runCursorTap(payload("afterFileEdit", { file_path: "/repo/x" }), deps())).toBe("{}");
    expect(calls).toHaveLength(0);
  });
});

describe("cursor transcript", () => {
  it("reads Claude Code and Codex shaped files through their own parsers", () => {
    const claude = [line({ type: "user", timestamp: "2026-11-06T10:00:00.000Z", message: { content: "fix" } }), line({ type: "assistant", message: { content: [{ type: "text", text: "Fixed." }, { type: "tool_use", input: { path: "src/a.ts" } }] } })].join("\n");
    expect(lastAssistantTurn(parseCursorTranscript(claude))).toEqual({ text: "Fixed.", paths: ["src/a.ts"] });
    const codex = line({ type: "response_item", timestamp: "2026-11-06T10:00:05.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Fixed in a.ts." }] } });
    expect(parseCursorTranscript(codex)).toEqual([{ role: "assistant", text: "Fixed in a.ts.", paths: [], at: Date.parse("2026-11-06T10:00:05.000Z") }]);
  });

  it("falls back to flat role records, as JSONL or one JSON array, with second or millisecond stamps", () => {
    const jsonl = [line({ role: "system", content: "rules" }), line({ role: "user", content: "fix", timestamp: "2026-11-06T10:00:00.000Z" }), line({ role: "assistant", content: [{ type: "text", text: "Fixed." }], createdAt: 1_762_423_205 }), "not json"].join("\n");
    expect(parseCursorTranscript(jsonl)).toEqual([
      { role: "user", text: "fix", paths: [], at: Date.parse("2026-11-06T10:00:00.000Z") },
      { role: "assistant", text: "Fixed.", paths: [], at: 1_762_423_205_000 },
    ]);
    const array = line([{ type: "user", text: "fix", created_at: 1_762_423_205_000 }, { type: "assistant", text: "Fixed." }]);
    expect(parseCursorTranscript(array).map((e) => [e.role, e.text, e.at])).toEqual([["user", "fix", 1_762_423_205_000], ["assistant", "Fixed.", 0]]);
    expect(parseCursorTranscript("")).toEqual([]);
    expect(parseCursorTranscript("{}\n[]\n")).toEqual([]);
  });
});

describe("cursor connect", () => {
  it("writes hooks.json and the skill under a project, upgrades in place, and removes only its own entries", () => {
    const paths = cursorPaths(dir);
    expect(paths).toEqual({ hooks: path.join(dir, ".cursor", "hooks.json"), skillDir: path.join(dir, ".cursor", "skills", "meshpoint") });
    mkdirSync(path.dirname(paths.hooks), { recursive: true });
    const user = { version: 1, hooks: { afterFileEdit: [{ command: ".cursor/hooks/format.sh" }], stop: [{ command: ".cursor/hooks/audit.sh", loop_limit: null }, { command: "meshpoint-tap cursor", timeout: 30 }] } };
    writeFileSync(paths.hooks, JSON.stringify(user));

    connectCursor({ remove: false, projectDir: dir });
    connectCursor({ remove: false, projectDir: dir });
    const hooks = JSON.parse(readFileSync(paths.hooks, "utf8"));
    expect(hooks.version).toBe(1);
    for (const event of CURSOR_EVENTS) expect(hooks.hooks[event].filter((h: { command: string }) => h.command.startsWith("meshpoint"))).toEqual([{ command: CURSOR_TAP_COMMAND, timeout: 30 }]);
    expect(hooks.hooks.afterFileEdit).toEqual(user.hooks.afterFileEdit);
    expect(hooks.hooks.stop).toEqual([{ command: ".cursor/hooks/audit.sh", loop_limit: null }, { command: CURSOR_TAP_COMMAND, timeout: 30 }]);
    const skill = readFileSync(path.join(paths.skillDir, "SKILL.md"), "utf8");
    expect(skill).toMatch(/^---\nname: meshpoint\ndescription: /);
    expect(skill).not.toContain("allowed-tools");
    expect(skill).toContain("meshpoint items put");

    connectCursor({ remove: true, projectDir: dir });
    expect(JSON.parse(readFileSync(paths.hooks, "utf8"))).toEqual({ version: 1, hooks: { afterFileEdit: user.hooks.afterFileEdit, stop: [user.hooks.stop[0]] } });
    expect(existsSync(paths.skillDir)).toBe(false);
  });

  it("deletes a hooks.json it alone populated, and tolerates removing when nothing is installed", () => {
    const paths = cursorPaths(dir);
    connectCursor({ remove: false, projectDir: dir });
    expect(JSON.parse(readFileSync(paths.hooks, "utf8")).version).toBe(1);
    connectCursor({ remove: true, projectDir: dir });
    expect(existsSync(paths.hooks)).toBe(false);
    expect(connectCursor({ remove: true, projectDir: dir })).toContain("removed");
    expect(existsSync(paths.skillDir)).toBe(false);
  });

  it("defaults to ~/.cursor for the global layout", () => {
    expect(cursorPaths(undefined, "/home/u")).toEqual({ hooks: "/home/u/.cursor/hooks.json", skillDir: "/home/u/.cursor/skills/meshpoint" });
  });
});
