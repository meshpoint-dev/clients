// Finds the coding harnesses present on this machine and whether each already runs the meshpoint
// tap. `meshpoint connect` with no name prints this; `meshpoint doctor` reuses it. Nothing here
// writes anything.
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { antigravityPaths, MESHPOINT_GROUP } from "./antigravity/connect.js";
import { claudeConfigDir } from "./claude-code/connect.js";
import { TAP_COMMAND } from "./claude-code/settings.js";
import { CODEX_TAP_COMMAND, codexPaths } from "./codex/connect.js";
import type { Environment } from "./config.js";
import { CURSOR_TAP_COMMAND, cursorPaths } from "./cursor/connect.js";
import { openclawHooksDir } from "./openclaw/connect.js";
import { PACK_NAME } from "./openclaw/pack.js";
import { opencodeConfigDir, opencodePaths } from "./opencode/connect.js";
import { piPaths } from "./pi/connect.js";

export const HARNESSES = ["claude-code", "codex", "cursor", "antigravity", "pi", "opencode", "openclaw"] as const;
export type Harness = (typeof HARNESSES)[number];

export interface HarnessStatus {
  harness: Harness;
  // How the harness was found (a directory or a binary on PATH); null when absent.
  detected: string | null;
  // Where the meshpoint hook or plugin would live for this scope.
  hookPath: string;
  connected: boolean;
  command: string;
}

export interface DetectOptions {
  env?: Environment;
  home?: string;
  // When set, `connected` and `command` describe that repo's scope instead of the user scope.
  projectDir?: string;
}

function onPath(bin: string, env: Environment): string | null {
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

function found(dir: string, bin: string, env: Environment): string | null {
  if (existsSync(dir)) return dir;
  return onPath(bin, env);
}

function fileHas(file: string, needle: string): boolean {
  try {
    return readFileSync(file, "utf8").includes(needle);
  } catch {
    return false;
  }
}

function isLink(file: string): boolean {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

export function detectHarnesses(opts: DetectOptions = {}): HarnessStatus[] {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const project = opts.projectDir;
  const scope = project ? ` --project ${project}` : "";
  const claudeDir = project ? path.join(project, ".claude") : claudeConfigDir(env, home);
  const codex = codexPaths(project, env, home);
  const cursor = cursorPaths(project, home);
  const antigravity = antigravityPaths(project, home);
  const pi = piPaths(undefined, env, home);
  const opencode = opencodePaths(opencodeConfigDir(env, home));
  const openclawPack = path.join(openclawHooksDir(env, home), PACK_NAME);
  const claudeSettings = path.join(claudeDir, "settings.json");
  return [
    {
      harness: "claude-code",
      detected: found(claudeConfigDir(env, home), "claude", env),
      hookPath: claudeSettings,
      connected: fileHas(claudeSettings, TAP_COMMAND),
      command: `meshpoint connect claude-code${scope}`,
    },
    {
      harness: "codex",
      detected: found(env.CODEX_HOME || path.join(home, ".codex"), "codex", env),
      hookPath: codex.hooks,
      connected: fileHas(codex.hooks, CODEX_TAP_COMMAND),
      command: `meshpoint connect codex${scope}`,
    },
    {
      harness: "cursor",
      detected: found(path.join(home, ".cursor"), "cursor", env),
      hookPath: cursor.hooks,
      connected: fileHas(cursor.hooks, CURSOR_TAP_COMMAND),
      command: `meshpoint connect cursor${scope}`,
    },
    {
      harness: "antigravity",
      detected: found(path.join(home, ".gemini"), "antigravity", env),
      hookPath: antigravity.hooks,
      connected: fileHas(antigravity.hooks, `"${MESHPOINT_GROUP}"`),
      command: `meshpoint connect antigravity${scope}`,
    },
    {
      harness: "pi",
      detected: found(path.dirname(path.dirname(pi.extension)), "pi", env),
      hookPath: pi.extension,
      connected: fileHas(pi.extension, "meshpoint connect pi"),
      command: "meshpoint connect pi",
    },
    {
      harness: "opencode",
      detected: found(opencodeConfigDir(env, home), "opencode", env),
      hookPath: opencode.plugin,
      connected: isLink(opencode.plugin),
      command: "meshpoint connect opencode",
    },
    {
      harness: "openclaw",
      detected: found(path.dirname(openclawHooksDir(env, home)), "openclaw", env),
      hookPath: openclawPack,
      connected: existsSync(openclawPack),
      command: "meshpoint connect openclaw",
    },
  ];
}

// The table `meshpoint connect` prints. Agents read it; keep the columns stable.
export function renderDetected(rows: HarnessStatus[]): string {
  const lines = ["harness      detected  connected  command"];
  for (const r of rows) {
    lines.push(`${r.harness.padEnd(12)} ${(r.detected ? "yes" : "no").padEnd(9)} ${(r.connected ? "yes" : "no").padEnd(10)} ${r.command}`);
  }
  const present = rows.filter((r) => r.detected);
  lines.push("");
  lines.push(
    present.length === 0
      ? "No harness found. Install one, or run the connect command for the harness you use anyway."
      : `Found ${present.length}: ${present.map((r) => r.harness).join(", ")}. Run the connect command for each one you want on the mesh.`,
  );
  return lines.join("\n");
}
