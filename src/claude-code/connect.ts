import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Environment } from "../config.js";
import { installTapHooks, removeTapHooks, type ClaudeCodeSettings } from "./settings.js";
import { SKILL_MD, SKILL_NAME } from "./skill.js";

export function claudeConfigDir(env: Environment = process.env, home = homedir()): string {
  return env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
}

// Installs or removes the managed hook entries in <config dir>/settings.json and the checkpoint
// skill in <config dir>/skills/.
export function connectClaudeCode(opts: { remove: boolean; configDir?: string }): string {
  const configDir = opts.configDir ?? claudeConfigDir();
  const settingsPath = path.join(configDir, "settings.json");
  const skillDir = path.join(configDir, "skills", SKILL_NAME);
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
  if (opts.remove) {
    rmSync(skillDir, { recursive: true, force: true });
    return `removed meshpoint hooks from ${settingsPath} and ${skillDir}`;
  }
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(path.join(skillDir, "SKILL.md"), SKILL_MD);
  return `installed meshpoint hooks in ${settingsPath} (SessionStart, UserPromptSubmit, Stop, PreCompact, SessionEnd) and ${skillDir}/SKILL.md`;
}
