import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHECKPOINT_TURNS, Checkpoints } from "../src/checkpoints.js";
import { connectOpencode, opencodeConfigDir, opencodePaths } from "../src/opencode/connect.js";
import { createOpencodeHooks, type OpencodeHooks } from "../src/opencode/hooks.js";
import { FLUSH_AFTER_MS, Spool } from "../src/spool.js";
import { Tap } from "../src/tap.js";

type Call = { method: string; url: string; body: any };

let dir: string;
let calls: Call[];
let prompts: any[];
let clock: number;

const REPO = { project: "github.com--acme--web", branch: "master", root: "/repo" };
const SESSION = { type: "session.created", properties: { info: { id: "s1", directory: "/repo" } } };

function fakeFetch() {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (url.includes("/v1/recall")) {
      return Response.json({
        project: "p",
        branch: "master",
        checkpoint: null,
        items: [{ id: "d1", kind: "decision", title: "Use KV", body: "edge speed", branch: "master", created_at: 1, confirmations: 0, retracted: 0, provenance: "" }],
        generated_at: clock,
        source: "kv",
      });
    }
    if (url.includes("/v1/presence")) return Response.json({ presence: [{ agent: "agent-2", user: "sam", branch: "master", paths: [], updated_at: clock }] });
    if (url.includes("/v1/context")) {
      return Response.json({ items: [], presence: url.includes("a.test.ts") ? [{ agent: "codex", user: "alice", branch: "feature", paths: ["tests/a.test.ts"], updated_at: clock }] : [] });
    }
    return Response.json({ accepted: 1 }, { status: 202 });
  }) as unknown as typeof fetch;
}

function hooks(over: { tracked?: boolean } = {}): OpencodeHooks & { spool: Spool } {
  const spool = new Spool(dir);
  const openTap = async (session: string, cwd: string) =>
    over.tracked === false
      ? null
      : new Tap({ config: { baseUrl: "https://api.test", token: "tok" }, repo: { ...REPO, root: cwd }, session, spool, checkpoints: new Checkpoints(dir), now: () => clock, fetch: fakeFetch(), presenceWaitMs: 20 });
  const client = { session: { promptAsync: vi.fn(async (opts: unknown) => void prompts.push(opts)) } };
  return Object.assign(createOpencodeHooks({ client, directory: "/repo", openTap, injectWaitMs: 500, now: () => clock }), { spool });
}

const captures = () => calls.filter((c) => c.url.includes("/v1/capture"));
const idle = { type: "session.idle", properties: { sessionID: "s1" } };

async function reply(h: OpencodeHooks, i: number) {
  await h["chat.message"]({ sessionID: "s1", agent: "build", model: { providerID: "p", modelID: "m" } }, { parts: [{ type: "text", text: `prompt ${i}` }] });
  clock += 1000;
  await h["experimental.text.complete"]({ sessionID: "s1", messageID: `m${i}` }, { text: `reply ${i}` });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "mp-opencode-"));
  calls = [];
  prompts = [];
  clock = 1_700_000_000_000;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("opencode hooks", () => {
  it("injects recall into the system prompt of every request once the session starts", async () => {
    const h = hooks();
    await h.event({ event: SESSION });
    const system = ["base"];
    await h["experimental.chat.system.transform"]({ sessionID: "s1" }, { system });
    expect(system).toHaveLength(2);
    expect(system[1]).toContain("# Meshpoint: github.com--acme--web @ master");
    expect(system[1]).toContain("- sam (agent-2, just now)");
    expect(system[1]).toContain("- d1 [decision] Use KV: edge speed");
    const again = ["base"];
    await h["experimental.chat.system.transform"]({ sessionID: "s1" }, { system: again });
    expect(again).toHaveLength(2);
    const unknown = ["base"];
    await h["experimental.chat.system.transform"]({ sessionID: "other" }, { system: unknown });
    expect(unknown).toEqual(["base"]);
  });

  it("spools prompts, replies and edited paths, and sends them once the spool is 60s old", async () => {
    const h = hooks();
    await h.event({ event: SESSION });
    await h["chat.message"]({ sessionID: "s1" }, { parts: [{ type: "text", text: "add tests" }, { type: "text", text: "hidden", synthetic: true }] });
    const edited = { title: "edit", output: "Edited tests/a.test.ts", metadata: {} };
    await h["tool.execute.after"]({ tool: "edit", sessionID: "s1", args: { filePath: "/repo/tests/a.test.ts" } }, edited);
    expect(edited.output).toBe("Edited tests/a.test.ts\n\nMeshpoint, tests/a.test.ts:\n- alice's codex edited this file just now on feature.");
    const read = { title: "read", output: "contents", metadata: {} };
    await h["tool.execute.after"]({ tool: "read", sessionID: "s1", args: { filePath: "/repo/src/x.ts" } }, read);
    expect(read.output).toBe("contents");
    await h["experimental.text.complete"]({ sessionID: "s1", messageID: "m1" }, { text: "Added." });
    expect(h.spool.read("s1").map((t) => [t.body, t.paths])).toEqual([
      ["[user] add tests", undefined],
      ["[assistant] Added.", ["tests/a.test.ts"]],
    ]);
    expect(captures()).toHaveLength(0);

    clock += FLUSH_AFTER_MS;
    await h.event({ event: idle });
    expect(captures()[0]?.body.turns.map((t: { body: string }) => t.body)).toEqual(["[user] add tests", "[assistant] Added."]);
    expect(h.spool.read("s1")).toHaveLength(0);
  });

  it("nudges once through a prompt when enough replies pile up and skips capturing the nudge itself", async () => {
    const h = hooks();
    await h.event({ event: SESSION });
    for (let i = 0; i < CHECKPOINT_TURNS - 1; i += 1) await reply(h, i);
    // A second text part of the same message is the same reply.
    await h["experimental.text.complete"]({ sessionID: "s1", messageID: `m${CHECKPOINT_TURNS - 2}` }, { text: "more" });
    await h.event({ event: idle });
    expect(prompts).toHaveLength(0);

    await reply(h, CHECKPOINT_TURNS);
    await h.event({ event: idle });
    expect(prompts).toHaveLength(1);
    const nudge: string = prompts[0].body.parts[0].text;
    expect(nudge).toContain("meshpoint skill");
    expect(prompts[0]).toMatchObject({ path: { id: "s1" }, body: { agent: "build", model: { providerID: "p", modelID: "m" } } });

    const before = h.spool.read("s1").length;
    await h["chat.message"]({ sessionID: "s1" }, { parts: [{ type: "text", text: nudge }] });
    expect(h.spool.read("s1")).toHaveLength(before);
    await h["experimental.text.complete"]({ sessionID: "s1", messageID: "mx" }, { text: "Items written." });
    await h.event({ event: idle });
    expect(prompts).toHaveLength(1);
  });

  it("flushes before compaction and deletion, and re-injects after compaction", async () => {
    const h = hooks();
    await h.event({ event: SESSION });
    await h["chat.message"]({ sessionID: "s1" }, { parts: [{ type: "text", text: "hi" }] });
    await h["experimental.session.compacting"]({ sessionID: "s1" });
    expect(captures()).toHaveLength(1);
    expect(calls.filter((c) => c.url.includes("/v1/recall"))).toHaveLength(1);
    await h.event({ event: { type: "session.compacted", properties: { sessionID: "s1" } } });
    await h["experimental.chat.system.transform"]({ sessionID: "s1" }, { system: [] });
    expect(calls.filter((c) => c.url.includes("/v1/recall"))).toHaveLength(2);

    await h["chat.message"]({ sessionID: "s1" }, { parts: [{ type: "text", text: "bye" }] });
    await h.event({ event: { type: "session.deleted", properties: { info: { id: "s1" } } } });
    expect(captures()).toHaveLength(2);
    await h["experimental.text.complete"]({ sessionID: "s1", messageID: "m9" }, { text: "late" });
    expect(h.spool.read("s1")).toHaveLength(0);
  });

  it("ignores subagent sessions and does nothing without a tap", async () => {
    const h = hooks();
    await h.event({ event: { type: "session.created", properties: { info: { id: "child", parentID: "s1", directory: "/repo" } } } });
    await h["chat.message"]({ sessionID: "child" }, { parts: [{ type: "text", text: "sub task" }] });
    await h["experimental.text.complete"]({ sessionID: "child", messageID: "c1" }, { text: "done" });
    expect(h.spool.read("child")).toHaveLength(0);

    const none = hooks({ tracked: false });
    await none.event({ event: SESSION });
    await none["chat.message"]({ sessionID: "s1" }, { parts: [{ type: "text", text: "hi" }] });
    await none["experimental.chat.system.transform"]({ sessionID: "s1" }, { system: [] });
    await none.event({ event: idle });
    expect(calls).toHaveLength(0);
    expect(prompts).toHaveLength(0);
  });
});

describe("opencode connect", () => {
  let configDir: string;
  beforeEach(() => {
    configDir = mkdtempSync(path.join(tmpdir(), "mp-opencode-cfg-"));
  });
  afterEach(() => rmSync(configDir, { recursive: true, force: true }));

  it("links the plugin, writes the skill, repeats cleanly and removes both", () => {
    const paths = opencodePaths(configDir);
    connectOpencode({ remove: false, configDir, pluginFile: "/dist/opencode/plugin.js" });
    connectOpencode({ remove: false, configDir, pluginFile: "/dist/opencode/plugin.js" });
    expect(lstatSync(paths.plugin).isSymbolicLink()).toBe(true);
    expect(readlinkSync(paths.plugin)).toBe("/dist/opencode/plugin.js");
    const skill = readFileSync(path.join(paths.skillDir, "SKILL.md"), "utf8");
    expect(skill).toContain("name: meshpoint");
    expect(skill).not.toContain("allowed-tools");

    connectOpencode({ remove: true, configDir });
    expect(existsSync(paths.plugin)).toBe(false);
    expect(existsSync(paths.skillDir)).toBe(false);
  });

  it("refuses to replace a plugin file it does not own", () => {
    const paths = opencodePaths(configDir);
    connectOpencode({ remove: false, configDir, pluginFile: "/dist/opencode/plugin.js" });
    rmSync(paths.plugin);
    writeFileSync(paths.plugin, "export const other = async () => ({});\n");
    expect(() => connectOpencode({ remove: false, configDir })).toThrow(/not a meshpoint link/);
    expect(() => connectOpencode({ remove: true, configDir })).toThrow(/not a meshpoint link/);
  });

  it("resolves the config dir from XDG_CONFIG_HOME or the home directory", () => {
    expect(opencodeConfigDir({ XDG_CONFIG_HOME: "/x/cfg" }, "/home/u")).toBe("/x/cfg/opencode");
    expect(opencodeConfigDir({}, "/home/u")).toBe("/home/u/.config/opencode");
  });
});
