import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lastAssistantTurn } from "../src/claude-code/transcript.js";
import { codexPaths, connectCodex, CODEX_TAP_COMMAND } from "../src/codex/connect.js";
import { parseCodexTranscript } from "../src/codex/transcript.js";

const line = (o: unknown) => JSON.stringify(o);
const rollout = [
  line({ type: "session_meta", payload: { id: "s" } }),
  line({ type: "response_item", timestamp: "2026-11-06T10:00:00.000Z", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "## Memory" }] } }),
  line({ type: "response_item", timestamp: "2026-11-06T10:00:00.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions\nstuff" }] } }),
  line({ type: "response_item", timestamp: "2026-11-06T10:00:01.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "fix the bug" }] } }),
  line({ type: "response_item", timestamp: "2026-11-06T10:00:02.000Z", payload: { type: "reasoning", summary: [] } }),
  line({ type: "response_item", timestamp: "2026-11-06T10:00:03.000Z", payload: { type: "function_call", name: "exec_command", arguments: line({ cmd: "sed -n 1,5p src/a.ts" }) } }),
  line({ type: "response_item", timestamp: "2026-11-06T10:00:04.000Z", payload: { type: "function_call", name: "apply_patch", arguments: line({ input: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** End Patch" }) } }),
  line({ type: "response_item", timestamp: "2026-11-06T10:00:05.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Fixed in a.ts." }] } }),
  line({ type: "event_msg", payload: { type: "task_complete" } }),
].join("\n");

describe("codex transcript", () => {
  it("keeps user prose, assistant text and patched paths; drops injected and tool records", () => {
    const entries = parseCodexTranscript(rollout);
    expect(entries.map((e) => [e.role, e.text, e.paths])).toEqual([
      ["user", "fix the bug", []],
      ["assistant", "", ["src/a.ts"]],
      ["assistant", "Fixed in a.ts.", []],
    ]);
    expect(entries[0]?.at).toBe(Date.parse("2026-11-06T10:00:01.000Z"));
    expect(lastAssistantTurn(entries)).toEqual({ text: "Fixed in a.ts.", paths: ["src/a.ts"] });
  });
});

describe("codex connect", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "mp-codex-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes hooks, rules and the skill under a project, keeps user hooks, and removes cleanly", () => {
    const paths = codexPaths(dir);
    expect(paths).toEqual({
      hooks: path.join(dir, ".codex", "hooks.json"),
      rules: path.join(dir, ".codex", "rules", "meshpoint.rules"),
      skillDir: path.join(dir, ".agents", "skills", "meshpoint"),
    });
    connectCodex({ remove: false, projectDir: dir });
    connectCodex({ remove: false, projectDir: dir });
    const hooks = JSON.parse(readFileSync(paths.hooks, "utf8"));
    for (const event of ["SessionStart", "UserPromptSubmit", "Stop", "PreCompact", "SessionEnd"]) {
      const handlers = hooks.hooks[event].flatMap((g: { hooks: unknown[] }) => g.hooks);
      expect(handlers).toEqual([{ type: "command", command: CODEX_TAP_COMMAND, timeout: 30, additionalContextLimit: 100_000 }]);
    }
    expect(readFileSync(paths.rules, "utf8")).toContain('pattern = ["meshpoint", "items", "put"]');
    const skill = readFileSync(path.join(paths.skillDir, "SKILL.md"), "utf8");
    expect(skill).toContain("name: meshpoint");
    expect(skill).not.toContain("allowed-tools");

    connectCodex({ remove: true, projectDir: dir });
    expect(existsSync(paths.hooks)).toBe(false);
    expect(existsSync(paths.rules)).toBe(false);
    expect(existsSync(paths.skillDir)).toBe(false);
  });

  it("resolves global paths from CODEX_HOME and the home directory", () => {
    const paths = codexPaths(undefined, { CODEX_HOME: "/x/codex" }, "/home/u");
    expect(paths.hooks).toBe("/x/codex/hooks.json");
    expect(paths.skillDir).toBe("/home/u/.agents/skills/meshpoint");
  });
});
