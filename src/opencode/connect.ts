import { lstatSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { skillMarkdown, SKILL_NAME } from "../claude-code/skill.js";
import type { Environment } from "../config.js";

export function opencodeConfigDir(env: Environment = process.env, home = homedir()): string {
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "opencode");
}

// opencode imports a linked plugin through its real path, so ../runtime.js and @meshpoint/sdk
// resolve from dist; the link itself is what `connect --remove` recognises as ours.
export const PLUGIN_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "plugin.js");

export interface OpencodePaths {
  plugin: string;
  skillDir: string;
}

// opencode loads <config dir>/plugins/*.js and <config dir>/{skill,skills}/**/SKILL.md.
export function opencodePaths(configDir: string): OpencodePaths {
  return { plugin: path.join(configDir, "plugins", "meshpoint.js"), skillDir: path.join(configDir, "skills", SKILL_NAME) };
}

export function connectOpencode(opts: { remove: boolean; configDir?: string; pluginFile?: string }): string {
  const paths = opencodePaths(opts.configDir ?? opencodeConfigDir());
  let existing: ReturnType<typeof lstatSync> | undefined;
  try {
    existing = lstatSync(paths.plugin);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`could not read ${paths.plugin}: ${(err as Error).message}`);
  }
  if (existing && !existing.isSymbolicLink()) throw new Error(`${paths.plugin} exists and is not a meshpoint link; move it aside first`);
  if (opts.remove) {
    rmSync(paths.plugin, { force: true });
    rmSync(paths.skillDir, { recursive: true, force: true });
    return `removed meshpoint plugin ${paths.plugin} and ${paths.skillDir}`;
  }
  const target = opts.pluginFile ?? PLUGIN_FILE;
  mkdirSync(path.dirname(paths.plugin), { recursive: true });
  rmSync(paths.plugin, { force: true });
  symlinkSync(target, paths.plugin);
  mkdirSync(paths.skillDir, { recursive: true });
  writeFileSync(path.join(paths.skillDir, "SKILL.md"), skillMarkdown({ allowedTools: false }));
  return `installed meshpoint plugin ${paths.plugin} -> ${target} and ${paths.skillDir}/SKILL.md. Restart opencode to load it.`;
}
