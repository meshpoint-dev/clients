import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptEntry } from "../src/claude-code/transcript.js";
import { connectPi, extensionStub, piPaths } from "../src/pi/connect.js";
import { assistantEntries, INJECT_TYPE, meshpointExtension, NUDGE_TYPE, type PiApi, type PiContext, type PiEvents, type TapLike } from "../src/pi/extension.js";

type Handler = (event: unknown, ctx: PiContext) => unknown;

class FakePi implements PiApi {
  handlers = new Map<string, Handler[]>();
  on<E extends keyof PiEvents>(event: E, handler: (event: PiEvents[E][0], ctx: PiContext) => unknown): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler as Handler]);
  }
  // Runs every handler in order and returns the last result, as pi does for notification events.
  async emit<E extends keyof PiEvents>(event: E, payload: PiEvents[E][0], ctx: PiContext = context()): Promise<PiEvents[E][1]> {
    let out: unknown;
    for (const h of this.handlers.get(event) ?? []) out = await h(payload, ctx);
    return out as PiEvents[E][1];
  }
}

function context(branch: PiContext["sessionManager"]["getBranch"] = () => []): PiContext {
  return { cwd: "/repo/sub", sessionManager: { getSessionId: () => "sess-1", getBranch: branch } };
}

function fakeTap(over: Partial<TapLike> = {}): TapLike & { calls: string[]; entries: readonly TranscriptEntry[] } {
  const calls: string[] = [];
  const tap = {
    calls,
    entries: [] as readonly TranscriptEntry[],
    start: vi.fn(async () => {
      calls.push("start");
      return "# Meshpoint: recall";
    }),
    user: vi.fn(async (prompt: string) => {
      calls.push(`user:${prompt}`);
    }),
    assistant: vi.fn(async (text: string, paths: string[] = []) => {
      calls.push(`assistant:${text}:${paths.join(",")}`);
    }),
    nudge: vi.fn((entries: readonly TranscriptEntry[]) => {
      tap.entries = entries;
      calls.push("nudge");
      return null as string | null;
    }),
    end: vi.fn(async () => {
      calls.push("end");
    }),
    ...over,
  };
  return tap;
}

const assistantMessage = (text: string, at = 5) => ({ role: "assistant", content: [{ type: "text", text }], timestamp: at });

describe("pi extension", () => {
  it("opens the tap at session start and injects recall once, on the first user run", async () => {
    const pi = new FakePi();
    const tap = fakeTap();
    const open = vi.fn(async () => tap);
    meshpointExtension(pi, { open });

    await pi.emit("session_start", { reason: "startup" });
    expect(open).toHaveBeenCalledWith("sess-1", "/repo/sub");
    const first = await pi.emit("before_agent_start", { messageType: "user", prompt: "fix it" });
    expect(first).toEqual({ message: { customType: INJECT_TYPE, content: "# Meshpoint: recall", display: false } });
    expect(tap.calls).toEqual(["start", "user:fix it"]);

    expect(await pi.emit("before_agent_start", { messageType: "user", prompt: "again" })).toBeUndefined();
    expect(await pi.emit("before_agent_start", { messageType: "custom" })).toBeUndefined();
    expect(tap.user).toHaveBeenCalledTimes(2);
  });

  it("spools the run's reply with the files edit and write touched, resolved against cwd", async () => {
    const pi = new FakePi();
    const tap = fakeTap();
    meshpointExtension(pi, { open: async () => tap, now: () => 1000 });
    await pi.emit("session_start", { reason: "startup" });
    await pi.emit("before_agent_start", { messageType: "user", prompt: "go" });

    await pi.emit("turn_end", { message: assistantMessage("Looking.") });
    await pi.emit("tool_call", { toolName: "read", input: { path: "src/a.ts" } });
    await pi.emit("tool_call", { toolName: "edit", input: { path: "src/a.ts", edits: [] } });
    await pi.emit("tool_call", { toolName: "write", input: { path: "/repo/sub/src/b.ts", content: "" } });
    await pi.emit("tool_call", { toolName: "edit", input: { path: "src/a.ts", edits: [] } });
    await pi.emit("turn_end", { message: { role: "user", content: "tool result" } });
    await pi.emit("turn_end", { message: assistantMessage("Done.") });
    expect(await pi.emit("agent_before_settle", { outcome: "completed" })).toBeUndefined();
    expect(tap.assistant).toHaveBeenCalledWith("Looking.\n\nDone.", ["/repo/sub/src/a.ts", "/repo/sub/src/b.ts"]);
    expect(tap.entries).toEqual([{ role: "assistant", text: "Looking.\n\nDone.", paths: ["/repo/sub/src/a.ts", "/repo/sub/src/b.ts"], at: 1000 }]);

    // The next run starts clean; a run with nothing to say spools nothing.
    expect(await pi.emit("agent_before_settle", { outcome: "completed" })).toBeUndefined();
    expect(tap.assistant).toHaveBeenCalledTimes(1);
  });

  it("appends the nudge and asks for one more model request when a checkpoint is due", async () => {
    const pi = new FakePi();
    const tap = fakeTap({ nudge: vi.fn(() => "Meshpoint checkpoint due. Run the meshpoint skill now, then continue.") });
    meshpointExtension(pi, { open: async () => tap });
    await pi.emit("session_start", { reason: "startup" });
    await pi.emit("turn_end", { message: assistantMessage("Reply.") });
    expect(await pi.emit("agent_before_settle", { outcome: "completed" })).toEqual({
      entries: [{ type: "custom_message", customType: NUDGE_TYPE, content: "Meshpoint checkpoint due. Run the meshpoint skill now, then continue.", display: true }],
      continue: true,
    });

    // An aborted run is spooled but never continued.
    await pi.emit("turn_end", { message: assistantMessage("Partial.") });
    expect(await pi.emit("agent_before_settle", { outcome: "aborted" })).toBeUndefined();
    expect(tap.assistant).toHaveBeenCalledWith("Partial.", []);
    expect(tap.nudge).toHaveBeenCalledTimes(1);
  });

  it("counts the resumed branch's assistant replies toward the checkpoint", async () => {
    const pi = new FakePi();
    const tap = fakeTap();
    meshpointExtension(pi, { open: async () => tap, now: () => 9 });
    const branch = () => [
      { type: "session" },
      { type: "message", message: { role: "user", content: "hi", timestamp: 1 } },
      { type: "message", message: assistantMessage("earlier", 2) },
      { type: "message", message: { role: "assistant", content: [{ type: "toolCall" }], timestamp: 3 } },
    ];
    await pi.emit("session_start", { reason: "resume" }, context(branch));
    await pi.emit("turn_end", { message: assistantMessage("now") });
    await pi.emit("agent_before_settle", { outcome: "completed" });
    expect(tap.entries).toEqual([
      { role: "assistant", text: "earlier", paths: [], at: 2 },
      { role: "assistant", text: "now", paths: [], at: 9 },
    ]);
  });

  it("flushes before compaction, re-injects recall after it, and flushes at shutdown", async () => {
    const pi = new FakePi();
    const tap = fakeTap();
    meshpointExtension(pi, { open: async () => tap });
    await pi.emit("session_start", { reason: "startup" });
    await pi.emit("before_agent_start", { messageType: "user", prompt: "one" });
    await pi.emit("session_before_compact", { reason: "threshold" });
    await pi.emit("session_compact", { reason: "threshold" });
    expect(await pi.emit("before_agent_start", { messageType: "user", prompt: "two" })).toEqual({
      message: { customType: INJECT_TYPE, content: "# Meshpoint: recall", display: false },
    });
    await pi.emit("session_shutdown", { reason: "quit" });
    expect(tap.calls).toEqual(["start", "user:one", "end", "start", "user:two", "end"]);

    // After shutdown the old tap is gone: nothing is spooled and nothing is injected.
    await pi.emit("turn_end", { message: assistantMessage("late") });
    expect(await pi.emit("agent_before_settle", { outcome: "completed" })).toBeUndefined();
    expect(await pi.emit("before_agent_start", { messageType: "user", prompt: "three" })).toBeUndefined();
    expect(tap.end).toHaveBeenCalledTimes(2);
  });

  it("does nothing without a tap and swallows tap failures", async () => {
    const pi = new FakePi();
    meshpointExtension(pi, { open: async () => null });
    await pi.emit("session_start", { reason: "startup" });
    expect(await pi.emit("before_agent_start", { messageType: "user", prompt: "x" })).toBeUndefined();
    await pi.emit("turn_end", { message: assistantMessage("y") });
    expect(await pi.emit("agent_before_settle", { outcome: "completed" })).toBeUndefined();

    const broken = new FakePi();
    const tap = fakeTap({
      user: vi.fn(async () => {
        throw new Error("mesh down");
      }),
      end: vi.fn(async () => {
        throw new Error("mesh down");
      }),
    });
    meshpointExtension(broken, { open: async () => tap });
    await broken.emit("session_start", { reason: "startup" });
    await expect(broken.emit("before_agent_start", { messageType: "user", prompt: "x" })).resolves.toBeUndefined();
    await expect(broken.emit("session_shutdown", { reason: "quit" })).resolves.toBeUndefined();
  });

  it("reads assistant text out of branch entries", () => {
    expect(assistantEntries([{ type: "message", message: { role: "assistant", content: "  plain  ", timestamp: 4 } }])).toEqual([
      { role: "assistant", text: "plain", paths: [], at: 4 },
    ]);
    expect(assistantEntries([{ type: "message", message: { role: "assistant", content: [{ type: "thinking" }] } }])).toEqual([]);
  });
});

describe("pi connect", () => {
  let dir: string;
  let source: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "mp-pi-"));
    source = path.join(dir, "dist-extension.js");
    writeFileSync(source, "export default function () {}\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes the extension stub and the skill, and removes both", () => {
    const piDir = path.join(dir, "agent");
    const paths = piPaths(piDir);
    expect(paths).toEqual({ extension: path.join(piDir, "extensions", "meshpoint.js"), skillDir: path.join(piDir, "skills", "meshpoint") });

    connectPi({ remove: false, piDir, source });
    connectPi({ remove: false, piDir, source });
    expect(readFileSync(paths.extension, "utf8")).toBe(extensionStub(source));
    expect(extensionStub(source)).toContain(`export { default } from ${JSON.stringify(source)};`);
    const skill = readFileSync(path.join(paths.skillDir, "SKILL.md"), "utf8");
    expect(skill).toContain("name: meshpoint");
    expect(skill).not.toContain("allowed-tools");

    connectPi({ remove: true, piDir, source });
    connectPi({ remove: true, piDir, source });
    expect(existsSync(paths.extension)).toBe(false);
    expect(existsSync(paths.skillDir)).toBe(false);
  });

  it("refuses to replace a file it did not write and a missing build", () => {
    const piDir = path.join(dir, "agent");
    const paths = piPaths(piDir);
    expect(() => connectPi({ remove: false, piDir, source: path.join(dir, "nope.js") })).toThrow(/npm run build/);
    connectPi({ remove: false, piDir, source });
    writeFileSync(paths.extension, "// user's own extension\n");
    expect(() => connectPi({ remove: false, piDir, source })).toThrow(/not written by meshpoint/);
    expect(() => connectPi({ remove: true, piDir, source })).toThrow(/not written by meshpoint/);
  });

  it("resolves the default agent directory from PI_CODING_AGENT_DIR and the home directory", () => {
    expect(piPaths(undefined, { PI_CODING_AGENT_DIR: "/x/pi" }, "/home/u").extension).toBe("/x/pi/extensions/meshpoint.js");
    expect(piPaths(undefined, {}, "/home/u").skillDir).toBe("/home/u/.pi/agent/skills/meshpoint");
  });
});
