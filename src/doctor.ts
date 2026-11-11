// `meshpoint doctor`: is this machine ready for the mesh, and is this repo on it? Each check is
// ok, fail or info; the command exits 1 only on a fail. Agents run this after connecting.
import { accessSync, constants, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { configPath, loadConfig, repoContext, spoolDir, type Config, type Environment } from "./config.js";
import { api, ApiError, freshConfig } from "./control.js";
import { detectHarnesses } from "./detect.js";

export type CheckStatus = "ok" | "fail" | "info";

export interface Check {
  id: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: Check[];
}

export interface DoctorOptions {
  env?: Environment;
  home?: string;
  cwd?: string;
  fetch?: typeof fetch;
  now?: number;
}

interface Me {
  user: { id: string; email: string; name: string | null };
  org: { id: string; name: string; role: string } | null;
}

interface ProjectSummary {
  last_capture_at: number | null;
  items: number;
}

export function agoText(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

async function account(config: Config, fetchImpl: typeof fetch | undefined, env: Environment, home: string): Promise<{ me: Me; config: Config }> {
  const call = (c: Config) => api<Me>(c.baseUrl, "GET", "/v1/me", { token: c.token, fetch: fetchImpl });
  try {
    return { me: await call(config), config };
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 401 || !config.refresh) throw err;
    const next = await freshConfig(config, { force: true, ...(fetchImpl ? { fetch: fetchImpl } : {}), env, home });
    return { me: await call(next), config: next };
  }
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  const now = opts.now ?? Date.now();
  const checks: Check[] = [];

  let config = loadConfig(env, home);
  if (config) checks.push({ id: "config", status: "ok", detail: `${configPath(env, home)} (${config.baseUrl})` });
  else checks.push({ id: "config", status: "fail", detail: `no login at ${configPath(env, home)}; run meshpoint login` });

  if (config) {
    try {
      const got = await account(config, opts.fetch, env, home);
      config = got.config;
      checks.push({ id: "token", status: "ok", detail: `${got.me.user.email}, org ${got.me.org?.name ?? "none"}${got.me.org ? ` (${got.me.org.role})` : ""}` });
    } catch (err) {
      checks.push({ id: "token", status: "fail", detail: `token rejected: ${err instanceof Error ? err.message : String(err)}; run meshpoint login` });
      config = null;
    }
  }

  const repo = repoContext(cwd);
  if (repo) checks.push({ id: "repo", status: "ok", detail: `${repo.project} on ${repo.branch}` });
  else checks.push({ id: "repo", status: "fail", detail: `${cwd} is not inside a git repo with an origin remote` });

  const userScope = detectHarnesses({ env, home });
  const projectScope = repo ? detectHarnesses({ env, home, projectDir: repo.root }) : [];
  const present = userScope.filter((h) => h.detected);
  if (present.length === 0) checks.push({ id: "harness", status: "fail", detail: "no coding harness found on this machine" });
  for (const h of present) {
    const inProject = projectScope.find((p) => p.harness === h.harness);
    const where = h.connected ? "user scope" : inProject?.connected ? `this repo (${inProject.hookPath})` : null;
    checks.push(where ? { id: `harness:${h.harness}`, status: "ok", detail: `connected in ${where}` } : { id: `harness:${h.harness}`, status: "fail", detail: `found but not connected; run ${h.command}` });
  }

  if (config && repo) {
    try {
      const summary = await api<ProjectSummary>(config.baseUrl, "GET", `/v1/project?project=${encodeURIComponent(repo.project)}`, { token: config.token, fetch: opts.fetch });
      if (summary.last_capture_at) checks.push({ id: "capture", status: "ok", detail: `last capture ${agoText(summary.last_capture_at, now)}, ${summary.items} items` });
      else checks.push({ id: "capture", status: "info", detail: "no capture yet for this project; start a session in a connected harness" });
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) checks.push({ id: "capture", status: "info", detail: "project not on the platform yet; the first session creates it" });
      else checks.push({ id: "capture", status: "fail", detail: `could not read the project: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  const spool = spoolDir(env, home);
  try {
    mkdirSync(spool, { recursive: true, mode: 0o700 });
    accessSync(spool, constants.W_OK);
    const pending = readdirSync(spool).filter((f) => f.endsWith(".jsonl")).length;
    checks.push({ id: "spool", status: "ok", detail: `${spool} writable, ${pending} pending file${pending === 1 ? "" : "s"}` });
  } catch (err) {
    checks.push({ id: "spool", status: "fail", detail: `${spool} not writable: ${err instanceof Error ? err.message : String(err)}` });
  }

  return { ok: checks.every((c) => c.status !== "fail"), checks };
}

export function renderDoctor(report: DoctorReport): string {
  const mark: Record<CheckStatus, string> = { ok: "✓", fail: "✗", info: "·" };
  const lines = report.checks.map((c) => `${mark[c.status]} ${c.id.padEnd(20)} ${c.detail}`);
  lines.push(report.ok ? "ready" : "not ready: fix the ✗ lines above");
  return lines.join("\n");
}
