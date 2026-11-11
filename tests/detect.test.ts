import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { detectHarnesses, HARNESSES, renderDetected } from "../src/detect.js";

const home = mkdtempSync(path.join(tmpdir(), "mp-detect-"));
const bin = path.join(home, "bin");
mkdirSync(bin);
afterAll(() => rmSync(home, { recursive: true, force: true }));

// Only PATH and HOME-derived locations count; the real machine must not leak into the table.
const env = { HOME: home, PATH: bin };

describe("detectHarnesses", () => {
  it("reports absent harnesses as not detected and not connected", () => {
    const rows = detectHarnesses({ env, home });
    expect(rows.map((r) => r.harness)).toEqual([...HARNESSES]);
    expect(rows.every((r) => r.detected === null && !r.connected)).toBe(true);
    expect(rows.find((r) => r.harness === "cursor")?.command).toBe("meshpoint connect cursor");
  });

  it("detects by directory or by binary on PATH and reads the hook files for the connected state", () => {
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "meshpoint tap claude-code" }] }] } }));
    mkdirSync(path.join(home, ".codex"), { recursive: true });
    const pi = path.join(bin, "pi");
    writeFileSync(pi, "#!/usr/bin/env sh\n");
    chmodSync(pi, 0o755);
    mkdirSync(path.join(home, ".config", "opencode", "plugins"), { recursive: true });
    symlinkSync("/nowhere/plugin.js", path.join(home, ".config", "opencode", "plugins", "meshpoint.js"));

    const rows = Object.fromEntries(detectHarnesses({ env, home }).map((r) => [r.harness, r]));
    expect(rows["claude-code"]).toMatchObject({ detected: path.join(home, ".claude"), connected: true });
    expect(rows.codex).toMatchObject({ detected: path.join(home, ".codex"), connected: false, command: "meshpoint connect codex" });
    expect(rows.pi).toMatchObject({ detected: pi, connected: false });
    expect(rows.opencode).toMatchObject({ detected: path.join(home, ".config", "opencode"), connected: true });
    expect(rows.cursor?.detected).toBeNull();
  });

  it("describes a repo's scope when given a project directory", () => {
    const repo = path.join(home, "repo");
    mkdirSync(path.join(repo, ".cursor"), { recursive: true });
    writeFileSync(path.join(repo, ".cursor", "hooks.json"), JSON.stringify({ version: 1, hooks: { stop: [{ command: "meshpoint tap cursor" }] } }));
    const rows = Object.fromEntries(detectHarnesses({ env, home, projectDir: repo }).map((r) => [r.harness, r]));
    expect(rows.cursor).toMatchObject({ connected: true, hookPath: path.join(repo, ".cursor", "hooks.json"), command: `meshpoint connect cursor --project ${repo}` });
    // User-scope state is what "detected" means even when the scope is a repo.
    expect(rows["claude-code"]).toMatchObject({ detected: path.join(home, ".claude"), connected: false, command: `meshpoint connect claude-code --project ${repo}` });
  });

  it("renders a stable table", () => {
    const out = renderDetected(detectHarnesses({ env, home }));
    expect(out.split("\n")[0]).toBe("harness      detected  connected  command");
    expect(out).toContain("claude-code  yes       yes        meshpoint connect claude-code");
    expect(out).toContain("cursor       no        no         meshpoint connect cursor");
    expect(out).toMatch(/Found 4: claude-code, codex, pi, opencode\./);
  });
});
