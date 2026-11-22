import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { IMPORT_SKILL_NAME, importSkillMarkdown, skillMarkdown, SKILL_NAME } from "../claude-code/skill.js";

export const CURSOR_TAP_COMMAND = "meshpoint tap cursor";
const HOOK_TIMEOUT_S = 30;

// afterAgentResponse carries the reply text; stop only decides on the checkpoint nudge;
// postToolUse is where a file notice can reach the agent (additional_context).
export const CURSOR_EVENTS = ["sessionStart", "beforeSubmitPrompt", "postToolUse", "afterAgentResponse", "stop", "preCompact", "sessionEnd"] as const;

interface CursorHook {
  readonly command: string;
  readonly [key: string]: unknown;
}

// hooks.json per https://cursor.com/docs/hooks ("Configuration"): version is required, and each
// event maps to a flat array of definitions, not Claude Code's matcher groups.
export interface CursorHooksFile {
  readonly version?: number;
  readonly hooks?: Readonly<Record<string, readonly CursorHook[]>>;
  readonly [key: string]: unknown;
}

function isManaged(hook: CursorHook): boolean {
  return typeof hook.command === "string" && (hook.command.startsWith("meshpoint tap ") || hook.command.startsWith("meshpoint-tap "));
}

function withoutManaged(hooks: readonly CursorHook[] | undefined): CursorHook[] {
  return (hooks ?? []).filter((hook) => !isManaged(hook));
}

export function installCursorHooks(file: CursorHooksFile): CursorHooksFile {
  const hooks: Record<string, readonly CursorHook[]> = { ...file.hooks };
  for (const event of CURSOR_EVENTS) hooks[event] = [...withoutManaged(hooks[event]), { command: CURSOR_TAP_COMMAND, timeout: HOOK_TIMEOUT_S }];
  return { ...file, version: file.version ?? 1, hooks };
}

// Drops the hooks key when nothing the user wrote remains.
export function removeCursorHooks(file: CursorHooksFile): CursorHooksFile {
  const hooks: Record<string, readonly CursorHook[]> = {};
  for (const [event, defs] of Object.entries(file.hooks ?? {})) {
    const kept = withoutManaged(defs);
    if (kept.length > 0) hooks[event] = kept;
  }
  const { hooks: _dropped, ...rest } = file;
  return Object.keys(hooks).length > 0 ? { ...rest, hooks } : rest;
}

export interface CursorPaths {
  hooks: string;
  skillDir: string;
}

// Project layout: <repo>/.cursor/{hooks.json,skills/meshpoint}; global: the same under ~/.cursor.
// Skills are the always-available instructions Cursor offers the agent by name
// (https://cursor.com/docs/skills, "Skill directories"), which is what the nudge asks for.
export function cursorPaths(projectDir: string | undefined, home = homedir()): CursorPaths {
  const dir = path.join(projectDir ?? home, ".cursor");
  return { hooks: path.join(dir, "hooks.json"), skillDir: path.join(dir, "skills", SKILL_NAME) };
}

export function connectCursor(opts: { remove: boolean; projectDir?: string; paths?: CursorPaths }): string {
  const paths = opts.paths ?? cursorPaths(opts.projectDir);
  let file: CursorHooksFile = {};
  try {
    file = JSON.parse(readFileSync(paths.hooks, "utf8")) as CursorHooksFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`could not read ${paths.hooks}: ${(err as Error).message}`);
  }
  if (opts.remove) {
    const next = removeCursorHooks(file);
    if (next.hooks) writeFileSync(paths.hooks, `${JSON.stringify(next, null, 2)}\n`);
    else rmSync(paths.hooks, { force: true });
    rmSync(paths.skillDir, { recursive: true, force: true });
    rmSync(path.join(path.dirname(paths.skillDir), IMPORT_SKILL_NAME), { recursive: true, force: true });
    return `removed meshpoint hooks from ${paths.hooks} and ${paths.skillDir}`;
  }
  mkdirSync(path.dirname(paths.hooks), { recursive: true });
  writeFileSync(paths.hooks, `${JSON.stringify(installCursorHooks(file), null, 2)}\n`);
  mkdirSync(paths.skillDir, { recursive: true });
  // Cursor's SKILL.md frontmatter takes name and description; allowed-tools is Claude Code only.
  writeFileSync(path.join(paths.skillDir, "SKILL.md"), skillMarkdown({ allowedTools: false }));
  const importDir = path.join(path.dirname(paths.skillDir), IMPORT_SKILL_NAME);
  mkdirSync(importDir, { recursive: true });
  writeFileSync(path.join(importDir, "SKILL.md"), importSkillMarkdown({ allowedTools: false }));
  return `installed meshpoint hooks in ${paths.hooks} (${CURSOR_EVENTS.join(", ")}) and ${paths.skillDir}/SKILL.md. Cursor reloads hooks.json on save; the Hooks tab under Customize lists them.`;
}
