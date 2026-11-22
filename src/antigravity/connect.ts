import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { IMPORT_SKILL_NAME, importSkillMarkdown, skillMarkdown, SKILL_NAME } from "../claude-code/skill.js";

export const ANTIGRAVITY_TAP_COMMAND = "meshpoint tap antigravity";
export const MESHPOINT_GROUP = "meshpoint";
export const ANTIGRAVITY_EVENTS = ["SessionStart", "PreInvocation", "Stop"] as const;
const HOOK_TIMEOUT_S = 30;

// hooks.json maps hook names to event configurations (antigravity.google/docs/hooks, "Schema and
// file format"); meshpoint owns exactly one name and never touches the others. SessionStart,
// PreInvocation and Stop take a flat handler list. The payload carries no event name, so each
// handler passes its event as the command's argument.
export type AntigravityHooksFile = Readonly<Record<string, unknown>>;

export function installAntigravityHooks(file: AntigravityHooksFile): AntigravityHooksFile {
  const group: Record<string, unknown> = { enabled: true };
  for (const event of ANTIGRAVITY_EVENTS) {
    group[event] = [{ type: "command", command: `${ANTIGRAVITY_TAP_COMMAND} ${event}`, timeout: HOOK_TIMEOUT_S }];
  }
  return { ...file, [MESHPOINT_GROUP]: group };
}

export function removeAntigravityHooks(file: AntigravityHooksFile): AntigravityHooksFile {
  const { [MESHPOINT_GROUP]: _removed, ...rest } = file;
  return rest;
}

export interface AntigravityPaths {
  hooks: string;
  skillDir: string;
}

// Workspace layout: <repo>/.agents/{hooks.json,skills/meshpoint}. Global layout: ~/.gemini/config/
// {hooks.json,skills/meshpoint} (the hooks and skills references, per-surface file locations).
export function antigravityPaths(projectDir: string | undefined, home = homedir()): AntigravityPaths {
  const dir = projectDir ? path.join(projectDir, ".agents") : path.join(home, ".gemini", "config");
  return { hooks: path.join(dir, "hooks.json"), skillDir: path.join(dir, "skills", SKILL_NAME) };
}

export function connectAntigravity(opts: { remove: boolean; projectDir?: string; paths?: AntigravityPaths }): string {
  const paths = opts.paths ?? antigravityPaths(opts.projectDir);
  let file: AntigravityHooksFile = {};
  try {
    file = JSON.parse(readFileSync(paths.hooks, "utf8")) as AntigravityHooksFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`could not read ${paths.hooks}: ${(err as Error).message}`);
  }
  if (opts.remove) {
    const next = removeAntigravityHooks(file);
    if (Object.keys(next).length > 0) writeFileSync(paths.hooks, `${JSON.stringify(next, null, 2)}\n`);
    else rmSync(paths.hooks, { force: true });
    rmSync(paths.skillDir, { recursive: true, force: true });
    rmSync(path.join(path.dirname(paths.skillDir), IMPORT_SKILL_NAME), { recursive: true, force: true });
    return `removed the ${MESHPOINT_GROUP} hook group from ${paths.hooks} and ${paths.skillDir}`;
  }
  mkdirSync(path.dirname(paths.hooks), { recursive: true });
  writeFileSync(paths.hooks, `${JSON.stringify(installAntigravityHooks(file), null, 2)}\n`);
  mkdirSync(paths.skillDir, { recursive: true });
  writeFileSync(path.join(paths.skillDir, "SKILL.md"), skillMarkdown({ allowedTools: false }));
  const importDir = path.join(path.dirname(paths.skillDir), IMPORT_SKILL_NAME);
  mkdirSync(importDir, { recursive: true });
  writeFileSync(path.join(importDir, "SKILL.md"), importSkillMarkdown({ allowedTools: false }));
  return `installed the ${MESHPOINT_GROUP} hook group in ${paths.hooks} (${ANTIGRAVITY_EVENTS.join(", ")}) and ${paths.skillDir}/SKILL.md. Antigravity loads hooks.json on the next conversation; toggle it under Customizations > Hooks.`;
}
