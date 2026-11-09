import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANTIGRAVITY_EVENTS, ANTIGRAVITY_TAP_COMMAND, antigravityPaths, connectAntigravity } from "../src/antigravity/connect.js";
import { runAntigravityTap, type AntigravityTapDeps } from "../src/antigravity/tap.js";
import { parseAntigravityTranscript } from "../src/antigravity/transcript.js";
import { CHECKPOINT_TURNS, Checkpoints } from "../src/checkpoints.js";
import { lastAssistantTurn } from "../src/claude-code/transcript.js";
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
      line({ role: "user", timestamp: stamp((i - n) * 1000), parts: [{ text: `prompt ${i}` }] }),
      line({ role: "model", timestamp: stamp((i - n) * 1000 + 500), parts: [{ text: `reply ${i}` }] }),
    ].join("\n"),
  ).join("\n");
const transcript = [
  line({ role: "user", timestamp: "2026-11-08T10:00:00.000Z", parts: [{ text: "add tests" }] }),
  line({ role: "model", timestamp: "2026-11-08T10:00:02.000Z", parts: [{ functionCall: { name: "write_to_file", args: { TargetFile: "/repo/tests/a.test.ts", CodeContent: "x" } } }] }),
  line({ role: "user", timestamp: "2026-11-08T10:00:03.000Z", parts: [{ functionResponse: { name: "write_to_file", response: { ok: true } } }] }),
  line({ role: "model", timestamp: "2026-11-08T10:00:04.000Z", parts: [{ text: "Added." }] }),
].join("\n");

function deps(over: Partial<AntigravityTapDeps> = {}): AntigravityTapDeps {
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
    if (url.includes("/v1/presence")) return Response.json({ presence: [] });
    return Response.json({ accepted: 1 }, { status: 202 });
  });
  return {
    config: { baseUrl: "https://api.test", token: "tok" },
    repo: () => ({ project: "github.com--acme--web", branch: "master", root: "/repo" }),
    readTranscript: () => transcript,
    spool: new Spool(path.join(dir, "spool")),
    checkpoints: new Checkpoints(dir),
    stateDir: dir,
    now: () => clock,
    fetch: fetchImpl as unknown as typeof fetch,
    presenceWaitMs: 50,
    ...over,
  };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "mp-antigravity-"));
  calls = [];
  clock = 1_700_000_000_000;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// The documented payloads carry no event name; bin copies the command argument into hookEventName.
const payload = (hookEventName: string, extra: Record<string, unknown> = {}) => ({
  hookEventName,
  conversationId: "c1",
  workspacePaths: ["/repo", "/other"],
  transcriptPath: "/tmp/t.jsonl",
  lastUserInput: "add tests",
  ...extra,
});
const recalls = () => calls.filter((c) => c.url.includes("/v1/recall")).length;
const captures = () => calls.filter((c) => c.url.includes("/v1/capture"));

describe("antigravity transcript", () => {
  it("reads Gemini-shaped parts: user text, model text, tool paths; drops function responses", () => {
    const entries = parseAntigravityTranscript(transcript);
    expect(entries.map((e) => [e.role, e.text, e.paths])).toEqual([
      ["user", "add tests", []],
      ["assistant", "", ["/repo/tests/a.test.ts"]],
      ["assistant", "Added.", []],
    ]);
    expect(entries[0]?.at).toBe(Date.parse("2026-11-08T10:00:00.000Z"));
    expect(lastAssistantTurn(entries)).toEqual({ text: "Added.", paths: ["/repo/tests/a.test.ts"] });
  });

  it("also reads the generic role/content shape with numeric timestamps", () => {
    const entries = parseAntigravityTranscript(
      [
        line({ type: "user", timestamp: 1_700_000_000, message: { content: "fix it" } }),
        line({ type: "assistant", timestamp: 1_700_000_001_000, message: { content: [{ type: "text", text: "Fixed." }, { type: "tool_use", input: { AbsolutePath: "/repo/a.ts" } }] } }),
        "not json",
        line({ type: "metadata", v: 1 }),
      ].join("\n"),
    );
    expect(entries.map((e) => [e.role, e.text, e.paths, e.at])).toEqual([
      ["user", "fix it", [], 1_700_000_000_000],
      ["assistant", "Fixed.", ["/repo/a.ts"], 1_700_000_001_000],
    ]);
  });
});

describe("antigravity tap", () => {
  it("injects the recall once per conversation, across hook processes", async () => {
    const out = JSON.parse(await runAntigravityTap(payload("SessionStart"), deps()));
    const text: string = out.injectSteps[0].systemMessage.systemMessage;
    expect(out.injectSteps).toHaveLength(1);
    expect(text).toContain("# Meshpoint: github.com--acme--web @ master");
    expect(text).toContain("## Last checkpoint (2m ago)\nwe were refactoring auth");
    expect(text).toContain("- d1 [decision] Use KV: edge speed");
    expect(recalls()).toBe(1);

    // A new process for the same conversation: PreInvocation 0 and SessionStart both stay quiet.
    expect(await runAntigravityTap(payload("PreInvocation", { invocationNum: 0 }), deps())).toBe("{}");
    expect(await runAntigravityTap(payload("SessionStart"), deps())).toBe("{}");
    expect(recalls()).toBe(1);

    // Another conversation recalls again; without SessionStart the first PreInvocation does it.
    const other = JSON.parse(await runAntigravityTap(payload("PreInvocation", { conversationId: "c2", invocationNum: 0 }), deps()));
    expect(other.injectSteps[0].systemMessage.systemMessage).toContain("# Meshpoint");
    expect(recalls()).toBe(2);
    expect(await runAntigravityTap(payload("PreInvocation", { conversationId: "c2", invocationNum: 1 }), deps())).toBe("{}");
    expect(recalls()).toBe(2);
  });

  it("spools the prompt at the first invocation of an execution and not on repeats", async () => {
    const d = deps();
    await runAntigravityTap(payload("PreInvocation", { invocationNum: 0 }), d);
    await runAntigravityTap(payload("PreInvocation", { invocationNum: 1 }), d);
    await runAntigravityTap(payload("PreInvocation", { invocationNum: 0 }), deps());
    expect(d.spool.read("c1").map((t) => t.body)).toEqual(["[user] add tests"]);

    await runAntigravityTap(payload("PreInvocation", { invocationNum: 0, lastUserInput: "and docs" }), deps());
    expect(d.spool.read("c1").map((t) => t.body)).toEqual(["[user] add tests", "[user] and docs"]);

    // Without lastUserInput the prompt comes from the transcript.
    await runAntigravityTap(payload("PreInvocation", { conversationId: "c3", invocationNum: 0, lastUserInput: undefined }), deps());
    expect(d.spool.read("c3").map((t) => t.body)).toEqual(["[user] add tests"]);
  });

  it("spools the reply with its paths at Stop and sends the spool when fully idle", async () => {
    const d = deps();
    await runAntigravityTap(payload("PreInvocation", { invocationNum: 0 }), d);
    expect(await runAntigravityTap(payload("Stop", { executionNum: 1, terminationReason: "model_stop", fullyIdle: false }), d)).toBe('{"decision":"stop"}');
    expect(captures()).toHaveLength(0);
    expect(d.spool.read("c1").map((t) => t.body)).toEqual(["[user] add tests", "[assistant] Added."]);
    expect(d.spool.read("c1")[1]?.paths).toEqual(["tests/a.test.ts"]);

    expect(await runAntigravityTap(payload("Stop", { executionNum: 1, terminationReason: "model_stop", fullyIdle: true }), d)).toBe('{"decision":"stop"}');
    expect(captures()).toHaveLength(1);
    expect(captures()[0]?.body.turns.map((t: { body: string }) => t.body)).toEqual(["[user] add tests", "[assistant] Added.", "[assistant] Added."]);
    expect(d.spool.read("c1")).toHaveLength(0);
  });

  it("sends the spool once it is 60s old even while not idle", async () => {
    const d = deps();
    await runAntigravityTap(payload("PreInvocation", { invocationNum: 0 }), d);
    clock += FLUSH_AFTER_MS;
    await runAntigravityTap(payload("Stop", { fullyIdle: false }), d);
    expect(captures()).toHaveLength(1);
  });

  it("keeps the agent going once when a checkpoint is due", async () => {
    const d = deps({ readTranscript: () => replies(CHECKPOINT_TURNS) });
    const out = JSON.parse(await runAntigravityTap(payload("Stop", { fullyIdle: true }), d));
    expect(out.decision).toBe("continue");
    expect(out.reason).toContain("meshpoint");
    expect(await runAntigravityTap(payload("Stop", { fullyIdle: true }), d)).toBe('{"decision":"stop"}');
  });

  it("infers the event from the payload when the command argument is missing", async () => {
    const d = deps();
    const { hookEventName: _stop, ...stopPayload } = payload("", { fullyIdle: false });
    const stop = await runAntigravityTap(stopPayload, d);
    expect(stop).toBe('{"decision":"stop"}');
    expect(d.spool.read("c1").map((t) => t.body)).toEqual(["[assistant] Added."]);
    const { hookEventName: _pre, ...prePayload } = payload("", { invocationNum: 0 });
    const pre = JSON.parse(await runAntigravityTap(prePayload, d));
    expect(pre.injectSteps).toHaveLength(1);
  });

  it("answers quietly outside a repo, on unknown events and without a config of the mesh", async () => {
    const none = deps({ repo: () => null });
    expect(await runAntigravityTap(payload("SessionStart"), none)).toBe("{}");
    expect(await runAntigravityTap(payload("Stop", { fullyIdle: true }), none)).toBe('{"decision":"stop"}');
    expect(await runAntigravityTap(payload("PostInvocation", { invocationNum: 0 }), deps())).toBe("{}");
    expect(await runAntigravityTap({}, deps())).toBe("{}");
    expect(calls).toHaveLength(0);
    const down = deps({ fetch: (async () => Response.json({ error: "down" }, { status: 503 })) as unknown as typeof fetch });
    expect(await runAntigravityTap(payload("SessionStart"), down)).toBe("{}");
  });
});

describe("antigravity connect", () => {
  it("installs the meshpoint group under the workspace, upgrades in place, and removes only itself", () => {
    const paths = antigravityPaths(dir);
    expect(paths).toEqual({ hooks: path.join(dir, ".agents", "hooks.json"), skillDir: path.join(dir, ".agents", "skills", "meshpoint") });
    // A user group plus a stale meshpoint group from an older install.
    const mine = { PostToolUse: [{ matcher: "run_command", hooks: [{ command: "./lint.sh" }] }] };
    mkdirSync(path.dirname(paths.hooks), { recursive: true });
    writeFileSync(paths.hooks, `${JSON.stringify({ mine, meshpoint: { Stop: [{ command: "meshpoint-tap antigravity" }] } }, null, 2)}\n`);

    connectAntigravity({ remove: false, projectDir: dir });
    const hooks = JSON.parse(readFileSync(paths.hooks, "utf8"));
    expect(hooks.mine).toEqual(mine);
    expect(hooks.meshpoint.enabled).toBe(true);
    expect(Object.keys(hooks.meshpoint)).toEqual(["enabled", ...ANTIGRAVITY_EVENTS]);
    for (const event of ANTIGRAVITY_EVENTS) {
      expect(hooks.meshpoint[event]).toEqual([{ type: "command", command: `${ANTIGRAVITY_TAP_COMMAND} ${event}`, timeout: 30 }]);
    }
    const skill = readFileSync(path.join(paths.skillDir, "SKILL.md"), "utf8");
    expect(skill).toContain("name: meshpoint");
    expect(skill).not.toContain("allowed-tools");

    connectAntigravity({ remove: true, projectDir: dir });
    expect(JSON.parse(readFileSync(paths.hooks, "utf8"))).toEqual({ mine });
    expect(existsSync(paths.skillDir)).toBe(false);

    connectAntigravity({ remove: false, projectDir: dir });
    writeFileSync(paths.hooks, `${JSON.stringify({ meshpoint: {} })}\n`);
    connectAntigravity({ remove: true, projectDir: dir });
    expect(existsSync(paths.hooks)).toBe(false);
  });

  it("resolves global paths under ~/.gemini/config", () => {
    expect(antigravityPaths(undefined, "/home/u")).toEqual({ hooks: "/home/u/.gemini/config/hooks.json", skillDir: "/home/u/.gemini/config/skills/meshpoint" });
  });
});
