import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Environment } from "../config.js";
import { installTapHooks, removeTapHooks, type ClaudeCodeSettings } from "./settings.js";

export function claudeConfigDir(env: Environment = process.env, home = homedir()): string {
  return env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
}

// Installs or removes the managed hook entries in <config dir>/settings.json.
export function connectClaudeCode(opts: { remove: boolean; configDir?: string }): string {
  const configDir = opts.configDir ?? claudeConfigDir();
  const settingsPath = path.join(configDir, "settings.json");
  let settings: ClaudeCodeSettings = {};
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8")) as ClaudeCodeSettings;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`could not read ${settingsPath}: ${(err as Error).message}`);
    if (opts.remove) return `no settings at ${settingsPath}; nothing to remove`;
  }
  const next = opts.remove ? removeTapHooks(settings) : installTapHooks(settings);
  mkdirSync(configDir, { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`);
  return opts.remove
    ? `removed meshpoint hooks from ${settingsPath}`
    : `installed meshpoint hooks in ${settingsPath} (SessionStart, UserPromptSubmit, Stop, PreCompact, SessionEnd)`;
}
