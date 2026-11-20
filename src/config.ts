import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { projectIdFromRemote } from "@meshpoint/sdk";

export interface Config {
  baseUrl: string;
  token: string;
  // Present after `meshpoint login`; absent for tokens pasted with --token.
  refresh?: string;
  exp?: number;
  org?: string;
  orgName?: string;
  user?: string;
  email?: string;
  agent?: string;
}

export type Environment = Readonly<Record<string, string | undefined>>;

export function configPath(env: Environment = process.env, home = homedir()): string {
  return path.join(env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "meshpoint", "config.json");
}

// Only https reaches the platform; plain http is for a local development server.
export function allowedBaseUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1");
}

// Environment overrides the file; MESHPOINT_BASE_URL and MESHPOINT_TOKEN are enough on their own.
// The file's credentials never travel to an environment-supplied URL: a repository can set
// MESHPOINT_BASE_URL through a harness's project settings, and the hooks inherit that environment.
export function loadConfig(env: Environment = process.env, home = homedir()): Config | null {
  let fromFile: Partial<Config> = {};
  try {
    fromFile = JSON.parse(readFileSync(configPath(env, home), "utf8")) as Partial<Config>;
  } catch {
    fromFile = {};
  }
  const baseUrl = env.MESHPOINT_BASE_URL ?? fromFile.baseUrl;
  const token = env.MESHPOINT_TOKEN ?? fromFile.token;
  if (!baseUrl || !token || !allowedBaseUrl(baseUrl)) return null;
  // An environment token stands alone: file-held refresh state belongs to the file's token.
  if (env.MESHPOINT_TOKEN) return { baseUrl, token };
  if (env.MESHPOINT_BASE_URL && env.MESHPOINT_BASE_URL !== fromFile.baseUrl) return null;
  return { ...fromFile, baseUrl, token };
}

export function saveConfig(config: Config, env: Environment = process.env, home = homedir()): string {
  const file = configPath(env, home);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return file;
}

export function deleteConfig(env: Environment = process.env, home = homedir()): void {
  rmSync(configPath(env, home), { force: true });
}

export function stateDir(env: Environment = process.env, home = homedir()): string {
  return path.join(env.XDG_STATE_HOME ?? path.join(home, ".local", "state"), "meshpoint");
}

export function spoolDir(env: Environment = process.env, home = homedir()): string {
  return path.join(stateDir(env, home), "spool");
}

export interface RepoContext {
  project: string;
  branch: string;
  root: string;
}

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).toString().trim() || null;
  } catch {
    return null;
  }
}

// The project is the origin remote; the branch is whatever is checked out. Detached heads capture
// under "HEAD". A directory outside a repo with an origin remote has no project and is skipped.
export function repoContext(cwd: string): RepoContext | null {
  const remote = git(["remote", "get-url", "origin"], cwd);
  const root = git(["rev-parse", "--show-toplevel"], cwd);
  if (!remote || !root) return null;
  let project: string;
  try {
    project = projectIdFromRemote(remote);
  } catch {
    return null;
  }
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd) ?? "HEAD";
  return { project, branch, root };
}
