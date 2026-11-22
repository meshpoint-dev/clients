import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { IMPORT_SKILL_NAME, importSkillMarkdown, skillMarkdown, SKILL_NAME } from "../claude-code/skill.js";
import { installTapHooks, removeTapHooks, type ClaudeCodeSettings, type TapHookSpec } from "../claude-code/settings.js";
import type { Environment } from "../config.js";

export const CODEX_TAP_COMMAND = "meshpoint tap codex";
// Codex truncates additionalContext at 2500 chars by default; a recall inject is up to ~12k.
const CONTEXT_LIMIT = 100_000;

export const CODEX_SPEC: TapHookSpec = {
  command: CODEX_TAP_COMMAND,
  // Codex matches apply_patch under the Edit|Write aliases; the hook reads the files out of the patch.
  events: [{ event: "SessionStart" }, { event: "UserPromptSubmit" }, { event: "PreToolUse", matcher: "Edit|Write", timeout: 5 }, { event: "Stop" }, { event: "PreCompact" }, { event: "SessionEnd" }],
  extra: { additionalContextLimit: CONTEXT_LIMIT },
};

// Codex approves commands by prefix rules, not per skill; "allow" also runs them outside the
// sandbox, which the platform call needs for network access.
export const RULES = `# Managed by meshpoint connect codex. The checkpoint skill writes and retracts items.
prefix_rule(
    pattern = ["meshpoint", "items", "put"],
    decision = "allow",
    justification = "Meshpoint checkpoint: write team knowledge items",
)

prefix_rule(
    pattern = ["meshpoint", "items", "retract"],
    decision = "allow",
    justification = "Meshpoint checkpoint: retract obsolete items",
)
`;

export interface CodexPaths {
  hooks: string;
  rules: string;
  skillDir: string;
}

// Project layout: <repo>/.codex/{hooks.json,rules/meshpoint.rules} and <repo>/.agents/skills/meshpoint.
// Global layout: $CODEX_HOME (~/.codex) and ~/.agents/skills/meshpoint.
export function codexPaths(projectDir: string | undefined, env: Environment = process.env, home = homedir()): CodexPaths {
  const codexDir = projectDir ? path.join(projectDir, ".codex") : env.CODEX_HOME || path.join(home, ".codex");
  const agentsDir = path.join(projectDir ?? home, ".agents");
  return {
    hooks: path.join(codexDir, "hooks.json"),
    rules: path.join(codexDir, "rules", "meshpoint.rules"),
    skillDir: path.join(agentsDir, "skills", SKILL_NAME),
  };
}

export function connectCodex(opts: { remove: boolean; projectDir?: string; paths?: CodexPaths }): string {
  const paths = opts.paths ?? codexPaths(opts.projectDir);
  let settings: ClaudeCodeSettings = {};
  try {
    settings = JSON.parse(readFileSync(paths.hooks, "utf8")) as ClaudeCodeSettings;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`could not read ${paths.hooks}: ${(err as Error).message}`);
  }
  if (opts.remove) {
    const next = removeTapHooks(settings);
    if (Object.keys(next).length > 0) writeFileSync(paths.hooks, `${JSON.stringify(next, null, 2)}\n`);
    else rmSync(paths.hooks, { force: true });
    rmSync(paths.rules, { force: true });
    rmSync(paths.skillDir, { recursive: true, force: true });
    rmSync(path.join(path.dirname(paths.skillDir), IMPORT_SKILL_NAME), { recursive: true, force: true });
    return `removed meshpoint hooks from ${paths.hooks}, ${paths.rules} and ${paths.skillDir}`;
  }
  mkdirSync(path.dirname(paths.hooks), { recursive: true });
  writeFileSync(paths.hooks, `${JSON.stringify(installTapHooks(settings, CODEX_SPEC), null, 2)}\n`);
  mkdirSync(path.dirname(paths.rules), { recursive: true });
  writeFileSync(paths.rules, RULES);
  mkdirSync(paths.skillDir, { recursive: true });
  writeFileSync(path.join(paths.skillDir, "SKILL.md"), skillMarkdown({ allowedTools: false }));
  const importDir = path.join(path.dirname(paths.skillDir), IMPORT_SKILL_NAME);
  mkdirSync(importDir, { recursive: true });
  writeFileSync(path.join(importDir, "SKILL.md"), importSkillMarkdown({ allowedTools: false }));
  return `installed meshpoint hooks in ${paths.hooks}, rules in ${paths.rules} and ${paths.skillDir}/SKILL.md. Project .codex files load only once the project is trusted in config.toml; Codex asks to trust new hooks on the next run (/hooks).`;
}
