import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectAntigravity } from "../src/antigravity/connect.js";
import { connectClaudeCode } from "../src/claude-code/connect.js";
import { connectCodex } from "../src/codex/connect.js";
import { connectCursor } from "../src/cursor/connect.js";

// Without --project every adapter writes into the user's own config. The test redirects HOME so
// nothing on this machine is touched; os.homedir() follows $HOME.
const home = mkdtempSync(path.join(tmpdir(), "mp-global-"));
const saved: Record<string, string | undefined> = {};
const CLEARED = ["HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME", "PI_CODING_AGENT_DIR"];

beforeAll(() => {
  for (const k of CLEARED) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.HOME = home;
});
afterAll(() => {
  for (const k of CLEARED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(home, { recursive: true, force: true });
});

const read = (p: string) => readFileSync(path.join(home, p), "utf8");

describe("connect without --project", () => {
  it("claude-code writes ~/.claude/settings.json and the skill", () => {
    expect(connectClaudeCode({ remove: false })).toContain(path.join(home, ".claude", "settings.json"));
    expect(read(".claude/settings.json")).toContain("meshpoint tap claude-code");
    expect(existsSync(path.join(home, ".claude", "skills", "meshpoint", "SKILL.md"))).toBe(true);
    connectClaudeCode({ remove: true });
    expect(read(".claude/settings.json")).not.toContain("meshpoint");
    expect(existsSync(path.join(home, ".claude", "skills", "meshpoint"))).toBe(false);
  });

  it("codex writes ~/.codex hooks and rules and ~/.agents/skills", () => {
    connectCodex({ remove: false });
    expect(read(".codex/hooks.json")).toContain("meshpoint tap codex");
    expect(read(".codex/rules/meshpoint.rules")).toContain("prefix_rule");
    expect(existsSync(path.join(home, ".agents", "skills", "meshpoint", "SKILL.md"))).toBe(true);
    connectCodex({ remove: true });
    expect(existsSync(path.join(home, ".codex", "hooks.json"))).toBe(false);
    expect(existsSync(path.join(home, ".agents", "skills", "meshpoint"))).toBe(false);
  });

  it("cursor writes ~/.cursor/hooks.json and the skill", () => {
    connectCursor({ remove: false });
    expect(read(".cursor/hooks.json")).toContain("meshpoint tap cursor");
    expect(existsSync(path.join(home, ".cursor", "skills", "meshpoint", "SKILL.md"))).toBe(true);
    connectCursor({ remove: true });
    expect(existsSync(path.join(home, ".cursor", "hooks.json"))).toBe(false);
  });

  it("antigravity writes ~/.gemini/config/hooks.json and the skill", () => {
    connectAntigravity({ remove: false });
    expect(read(".gemini/config/hooks.json")).toContain('"meshpoint"');
    expect(existsSync(path.join(home, ".gemini", "config", "skills", "meshpoint", "SKILL.md"))).toBe(true);
    connectAntigravity({ remove: true });
    expect(existsSync(path.join(home, ".gemini", "config", "hooks.json"))).toBe(false);
  });
});
