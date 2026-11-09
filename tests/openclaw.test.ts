import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHECKPOINT_TURNS, Checkpoints } from "../src/checkpoints.js";
import { connectOpenclaw, openclawHooksDir } from "../src/openclaw/connect.js";
import { EVENTS, HOOK_NAME, PACK_NAME, packFiles } from "../src/openclaw/pack.js";
import { openclawRepo, ReplyLog, runOpenclawTap, type OpenclawTapDeps } from "../src/openclaw/tap.js";
import { FLUSH_AFTER_MS, Spool } from "../src/spool.js";

type Call = { method: string; url: string; body: any };

let dir: string;
let calls: Call[];
let clock: number;

function deps(over: Partial<OpenclawTapDeps> = {}): OpenclawTapDeps {
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (url.includes("/v1/recall")) {
      return Response.json({
        project: "p",
        branch: "main",
        checkpoint: null,
        items: [{ id: "d1", kind: "decision", title: "Use KV", body: "edge speed", branch: "main", created_at: 1, confirmations: 0, retracted: 0, provenance: "" }],
        generated_at: clock,
        source: "kv",
      });
    }
    if (url.includes("/v1/presence")) return Response.json({ presence: [] });
    return Response.json({ accepted: 1 }, { status: 202 });
  });
  return {
    config: { baseUrl: "https://api.test", token: "tok" },
    env: {},
    repo: (cwd) => (cwd === "/ws" ? { project: "github.com--acme--bot", branch: "master", root: "/ws" } : null),
    spool: new Spool(dir),
    checkpoints: new Checkpoints(dir),
    replies: new ReplyLog(dir),
    now: () => clock,
    fetch: fetchImpl as unknown as typeof fetch,
    presenceWaitMs: 50,
    ...over,
  };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "mp-openclaw-"));
  calls = [];
  clock = 1_700_000_000_000;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const event = (key: string, context: Record<string, unknown> = {}, sessionKey = "agent:main:main") => {
  const [type, action] = key.split(":") as [string, string];
  return { type, action, sessionKey, context: { sessionId: "sid-1", ...context } };
};

describe("openclaw project resolution", () => {
  const repo = (cwd: string) => (cwd === "/ws" ? { project: "github.com--acme--bot", branch: "master", root: "/ws" } : null);

  it("prefers the workspace repo, then MESHPOINT_PROJECT, else nothing", () => {
    expect(openclawRepo("/ws", { MESHPOINT_PROJECT: "ignored" }, repo)?.project).toBe("github.com--acme--bot");
    expect(openclawRepo("/chat", { MESHPOINT_PROJECT: "support-bot" }, repo)).toEqual({ project: "support-bot", branch: "main", root: "/chat" });
    expect(openclawRepo("/chat", { MESHPOINT_PROJECT: "support-bot", MESHPOINT_BRANCH: "release/2" }, repo)?.branch).toBe("release/2");
    expect(openclawRepo("/chat", {}, repo)).toBeNull();
    expect(openclawRepo(undefined, {}, repo)).toBeNull();
  });

  it("rejects project names outside [A-Za-z0-9._-]{1,128}", () => {
    for (const bad of ["", "a b", "x/y", "a".repeat(129), "é"]) expect(openclawRepo(undefined, { MESHPOINT_PROJECT: bad }, repo)).toBeNull();
    expect(openclawRepo(undefined, { MESHPOINT_PROJECT: "ok", MESHPOINT_BRANCH: "no spaces" }, repo)).toBeNull();
  });
});

describe("openclaw tap", () => {
  it("returns the recall block for agent:bootstrap and nothing without a project", async () => {
    const out = JSON.parse(await runOpenclawTap(event("agent:bootstrap", { workspaceDir: "/ws" }), deps()));
    expect(out.inject).toContain("# Meshpoint: github.com--acme--bot @ master");
    expect(out.inject).toContain("- d1 [decision] Use KV: edge speed");

    expect(await runOpenclawTap(event("agent:bootstrap", { workspaceDir: "/chat" }), deps())).toBe("{}");
    expect(await runOpenclawTap(event("message:received", { content: "hi" }), deps())).toBe("{}");
    expect(calls.filter((c) => c.url.includes("/v1/recall"))).toHaveLength(1);
  });

  it("uses MESHPOINT_PROJECT for a chat agent and spools turns under the session id", async () => {
    const d = deps({ env: { MESHPOINT_PROJECT: "support-bot" } });
    expect(await runOpenclawTap(event("message:received", { content: "hello" }), d)).toBe("{}");
    expect(await runOpenclawTap(event("message:sent", { content: "hi there", success: true }, "agent:main:telegram:123"), d)).toBe("{}");
    expect(await runOpenclawTap(event("message:sent", { content: "dropped", success: false }), d)).toBe("{}");
    expect(d.spool.read("sid-1").map((t) => [t.branch, t.body])).toEqual([
      ["main", "[user] hello"],
      ["main", "[assistant] hi there"],
    ]);
    expect(calls.filter((c) => c.url.includes("/v1/capture"))).toHaveLength(0);

    clock += FLUSH_AFTER_MS;
    await runOpenclawTap(event("message:received", { content: "more" }), d);
    const capture = calls.find((c) => c.url.includes("/v1/capture"));
    expect(capture?.body).toMatchObject({ project: "support-bot", branch: "main" });
    expect(capture?.body.turns.map((t: { body: string }) => t.body)).toEqual(["[user] hello", "[assistant] hi there", "[user] more"]);
  });

  it("flushes at once on command:new, command:reset and session:auto-reset", async () => {
    const d = deps({ env: { MESHPOINT_PROJECT: "support-bot" } });
    for (const key of ["command:new", "command:reset", "session:auto-reset"]) {
      await runOpenclawTap(event("message:received", { content: key }), d);
      expect(await runOpenclawTap(event(key), d)).toBe("{}");
      expect(d.spool.read("sid-1")).toHaveLength(0);
    }
    expect(calls.filter((c) => c.url.includes("/v1/capture"))).toHaveLength(3);
  });

  it("nudges a checkpoint after enough replies, once, from its own reply log", async () => {
    const d = deps({ env: { MESHPOINT_PROJECT: "support-bot" } });
    let out = "{}";
    for (let i = 0; i < CHECKPOINT_TURNS; i += 1) {
      clock += 1000;
      out = await runOpenclawTap(event("message:sent", { content: `reply ${i}`, success: true }), d);
    }
    expect(JSON.parse(out).nudge).toContain("meshpoint");
    expect(d.replies.entries("sid-1")).toHaveLength(0);
    clock += 1000;
    expect(await runOpenclawTap(event("message:sent", { content: "after", success: true }), d)).toBe("{}");

    // A session boundary drops the count too.
    await runOpenclawTap(event("command:new"), d);
    expect(d.replies.entries("sid-1")).toHaveLength(0);
  });

  it("never throws on malformed events", async () => {
    expect(await runOpenclawTap({}, deps({ env: { MESHPOINT_PROJECT: "support-bot" } }))).toBe("{}");
    expect(await runOpenclawTap({ type: "gateway", action: "startup" }, deps({ env: { MESHPOINT_PROJECT: "support-bot" } }))).toBe("{}");
  });
});

describe("openclaw pack", () => {
  it("is dependency-free, names the hook and subscribes to exact event keys", () => {
    const files = packFiles();
    expect(Object.keys(files).sort()).toEqual(["HOOK.md", "handler.js", "package.json"]);
    const pkg = JSON.parse(files["package.json"]!);
    expect(pkg).toMatchObject({ name: PACK_NAME, type: "module", openclaw: { hooks: ["."] } });
    expect(pkg.dependencies).toBeUndefined();
    expect(files["HOOK.md"]).toMatch(/^---\nname: meshpoint\n/);
    expect(files["HOOK.md"]).toContain(`"events": ${JSON.stringify(EVENTS)}`);
    expect(files["HOOK.md"]).toContain('"requires": { "bins": ["meshpoint"] }');
    expect(files["handler.js"]).toContain("export default async function handler(event)");
    expect(files["handler.js"]).toContain('execFile("meshpoint", ["tap", "openclaw"]');
    expect(files["handler.js"]).not.toMatch(/^import .* from "(?!node:)/m);
  });

  it("handler forwards a trimmed payload and injects the tap's answer as a bootstrap file", async () => {
    // Run the generated handler against a fake meshpoint binary on PATH.
    const bin = path.join(dir, "bin");
    mkdirSync(bin);
    const log = path.join(dir, "tap.log");
    writeFileSync(
      path.join(bin, "meshpoint"),
      `#!/usr/bin/env node
const fs = require("node:fs");
const input = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(log)}, input + "\\n");
const e = JSON.parse(input);
if (e.type === "agent") process.stdout.write(JSON.stringify({ inject: "# Meshpoint block" }));
else if (e.type === "message" && e.action === "sent") process.stdout.write(JSON.stringify({ nudge: "checkpoint due" }));
else process.stdout.write("{}");
`,
    );
    chmodSync(path.join(bin, "meshpoint"), 0o755);
    const handlerPath = path.join(dir, "handler.mjs");
    writeFileSync(handlerPath, packFiles()["handler.js"]!);
    const previous = process.env.PATH;
    process.env.PATH = `${bin}:${previous}`;
    try {
      const { default: handler } = (await import(handlerPath)) as { default: (e: unknown) => Promise<void> };
      const bootstrapFiles: unknown[] = [];
      const bootstrap = { type: "agent", action: "bootstrap", sessionKey: "agent:main:main", context: { sessionId: "s", workspaceDir: "/ws", bootstrapFiles, cfg: { secret: 1 } }, messages: [] };
      await handler(bootstrap);
      expect(bootstrapFiles).toEqual([{ name: "MESHPOINT.md", path: "/ws/MESHPOINT.md", content: "# Meshpoint block", missing: false }]);

      await handler({ type: "message", action: "sent", sessionKey: "agent:main:telegram:1", context: { sessionId: "s", to: "u", content: "reply", success: true }, messages: [] });
      bootstrapFiles.length = 0;
      await handler(bootstrap);
      expect((bootstrapFiles[0] as { content: string }).content).toBe("# Meshpoint block\n\ncheckpoint due");
      // The cached block is reused; the nudge was consumed.
      bootstrapFiles.length = 0;
      await handler(bootstrap);
      expect((bootstrapFiles[0] as { content: string }).content).toBe("# Meshpoint block");

      const seen = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(seen).toHaveLength(2);
      expect(seen[0]).toEqual({ type: "agent", action: "bootstrap", sessionKey: "agent:main:main", context: { sessionId: "s", workspaceDir: "/ws" } });
      expect(seen[1]).toEqual({ type: "message", action: "sent", sessionKey: "agent:main:telegram:1", context: { sessionId: "s", workspaceDir: "/ws", content: "reply", success: true } });
    } finally {
      process.env.PATH = previous;
    }
  });
});

describe("openclaw connect", () => {
  function fakeBin(): { bin: string; log: string } {
    const log = path.join(dir, "openclaw.log");
    const bin = path.join(dir, "openclaw");
    writeFileSync(
      bin,
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const dir = args[0] === "plugins" && args[1] === "install" ? fs.readdirSync(args[2]).sort() : [];
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, dir }) + "\\n");
if (args[0] === "hooks") { process.stderr.write("Hook not found: meshpoint"); process.exit(1); }
`,
    );
    chmodSync(bin, 0o755);
    return { bin, log };
  }

  it("writes the pack and installs it through the openclaw CLI, then removes by deleting the dir", () => {
    const { bin, log } = fakeBin();
    const packDir = path.join(dir, "pack");
    const installedDir = path.join(dir, "hooks", PACK_NAME);
    const out = connectOpenclaw({ remove: false, openclawBin: bin, packDir, installedDir });
    expect(out).toContain(PACK_NAME);
    expect(readFileSync(path.join(packDir, "HOOK.md"), "utf8")).toContain(`name: ${HOOK_NAME}`);
    const [install] = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(install).toEqual({ args: ["plugins", "install", packDir, "--force"], dir: ["HOOK.md", "handler.js", "package.json"] });

    mkdirSync(installedDir, { recursive: true });
    writeFileSync(path.join(installedDir, "HOOK.md"), "x");
    // A failing `hooks disable` (hook unknown) does not stop the removal.
    expect(connectOpenclaw({ remove: true, openclawBin: bin, packDir, installedDir })).toContain("removed");
    expect(existsSync(installedDir)).toBe(false);
    const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[1].args).toEqual(["hooks", "disable", HOOK_NAME]);
  });

  it("surfaces an install failure with the CLI's stderr", () => {
    const bin = path.join(dir, "openclaw-fail");
    writeFileSync(bin, '#!/usr/bin/env node\nprocess.stderr.write("package.json missing openclaw.hooks");\nprocess.exit(1);\n');
    chmodSync(bin, 0o755);
    expect(() => connectOpenclaw({ remove: false, openclawBin: bin, packDir: path.join(dir, "p2"), installedDir: dir })).toThrow(/plugins install .* failed: package.json missing openclaw.hooks/);
  });

  it("resolves the hooks dir from OPENCLAW_STATE_DIR or the home directory", () => {
    expect(openclawHooksDir({ OPENCLAW_STATE_DIR: "/x/state" }, "/home/u")).toBe("/x/state/hooks");
    expect(openclawHooksDir({}, "/home/u")).toBe("/home/u/.openclaw/hooks");
  });
});
