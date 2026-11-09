import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { skillMarkdown, SKILL_NAME } from "../claude-code/skill.js";
import type { Environment } from "../config.js";

export interface PiPaths {
  extension: string;
  skillDir: string;
}

// pi auto-loads every *.js in <agent-dir>/extensions, so no settings.json edit is needed.
export function piPaths(piDir: string | undefined, env: Environment = process.env, home = homedir()): PiPaths {
  const dir = piDir ?? env.PI_CODING_AGENT_DIR ?? path.join(home, ".pi", "agent");
  return {
    extension: path.join(dir, "extensions", "meshpoint.js"),
    skillDir: path.join(dir, "skills", SKILL_NAME),
  };
}

const MARKER = "// Managed by meshpoint connect pi.";

// A symlink does not work: pi's loader (jiti) resolves the extension's relative imports from the
// link's own directory. A stub that re-exports the built file by absolute path loads it from its
// real location, so ../runtime.js and @meshpoint/sdk resolve from the clients install.
export function extensionStub(source: string): string {
  return `${MARKER} Re-exports the built extension so its imports resolve from the install.\nexport { default } from ${JSON.stringify(source)};\n`;
}

function builtExtension(): string {
  return fileURLToPath(new URL("./extension.js", import.meta.url));
}

// true: our stub; false: someone else's file; null: absent.
function isManaged(file: string): boolean | null {
  try {
    return readFileSync(file, "utf8").startsWith(MARKER);
  } catch {
    return null;
  }
}

export function connectPi(opts: { remove: boolean; piDir?: string; paths?: PiPaths; source?: string }): string {
  const paths = opts.paths ?? piPaths(opts.piDir);
  if (isManaged(paths.extension) === false) throw new Error(`${paths.extension} exists and was not written by meshpoint; remove it manually`);
  if (opts.remove) {
    rmSync(paths.extension, { force: true });
    rmSync(paths.skillDir, { recursive: true, force: true });
    return `removed ${paths.extension} and ${paths.skillDir}`;
  }
  const source = opts.source ?? builtExtension();
  if (!existsSync(source)) throw new Error(`${source} is missing; run npm run build first`);
  mkdirSync(path.dirname(paths.extension), { recursive: true });
  writeFileSync(paths.extension, extensionStub(source));
  mkdirSync(paths.skillDir, { recursive: true });
  writeFileSync(path.join(paths.skillDir, "SKILL.md"), skillMarkdown({ allowedTools: false }));
  return `wrote ${paths.extension} (loads ${source}) and ${paths.skillDir}/SKILL.md. Restart pi (or /reload) to load it.`;
}
