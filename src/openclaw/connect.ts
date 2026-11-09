import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { Environment } from "../config.js";
import { HOOK_NAME, PACK_NAME, writePack } from "./pack.js";

// OpenClaw copies installed hook packs to <state dir>/hooks/<pack id>.
export function openclawHooksDir(env: Environment = process.env, home = homedir()): string {
  return path.join(env.OPENCLAW_STATE_DIR || path.join(home, ".openclaw"), "hooks");
}

export interface ConnectOpenclawOptions {
  remove: boolean;
  openclawBin?: string;
  // Where the pack is generated before install; a temp dir by default.
  packDir?: string;
  // Where OpenClaw installed the pack; derived from the state dir by default.
  installedDir?: string;
}

function openclaw(bin: string, args: string[]): string {
  try {
    return execFileSync(bin, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 120_000 });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
    const detail = (e.stderr || e.stdout || e.message).trim();
    throw new Error(`${bin} ${args.join(" ")} failed: ${detail}`);
  }
}

// Install goes through `openclaw plugins install` so OpenClaw records and enables the hook itself.
// `plugins uninstall` does not know hook packs, so removal disables the hook and deletes the dir.
export function connectOpenclaw(opts: ConnectOpenclawOptions): string {
  const bin = opts.openclawBin ?? "openclaw";
  const installed = opts.installedDir ?? path.join(openclawHooksDir(), PACK_NAME);
  if (opts.remove) {
    try {
      openclaw(bin, ["hooks", "disable", HOOK_NAME]);
    } catch {
      // Already disabled or never discovered; the directory is what keeps the hook loadable.
    }
    rmSync(installed, { recursive: true, force: true });
    return `removed hook pack ${PACK_NAME} from ${installed}. Restart the OpenClaw gateway to unload it.`;
  }
  const packDir = opts.packDir ?? mkdtempSync(path.join(tmpdir(), "meshpoint-openclaw-"));
  try {
    writePack(packDir);
    openclaw(bin, ["plugins", "install", packDir, "--force"]);
  } finally {
    if (!opts.packDir) rmSync(packDir, { recursive: true, force: true });
  }
  return `installed hook pack ${PACK_NAME} (hook ${HOOK_NAME}) into ${installed}. The gateway needs the meshpoint CLI on its PATH and a login; set MESHPOINT_PROJECT in its environment when the workspace is not a git checkout. Restart the gateway if hooks do not reload automatically.`;
}
