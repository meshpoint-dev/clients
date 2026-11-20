// Control-plane calls for the CLI: login through the platform's AuthKit flow, token refresh,
// account and org administration.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { hostname } from "node:os";
import { saveConfig, type Config, type Environment } from "./config.js";

export const REFRESH_WHEN_LEFT_S = 24 * 3600;
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export interface Grant {
  token: string;
  exp: number;
  refresh: string;
  org: string;
  org_name: string;
  user: string;
  email: string;
  agent: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(baseUrl: string, method: string, path: string, opts: { token?: string; body?: unknown; fetch?: typeof fetch | undefined } = {}): Promise<T> {
  const res = await (opts.fetch ?? fetch)(`${baseUrl.replace(/\/+$/, "")}${path}`, {
    method,
    headers: {
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  if (!res.ok) throw new ApiError(res.status, (parsed as { error?: string } | undefined)?.error ?? `${method} ${path} -> ${res.status}`);
  return parsed as T;
}

export function defaultAgentName(host = hostname()): string {
  const safe = host.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 100);
  return `cli-${safe || "host"}`;
}

export function configFromGrant(baseUrl: string, g: Grant): Config {
  return { baseUrl, token: g.token, refresh: g.refresh, exp: g.exp, org: g.org, orgName: g.org_name, user: g.user, email: g.email, agent: g.agent };
}

export interface LoginOptions {
  baseUrl: string;
  agent?: string;
  org?: string;
  // Receives the URL to open in a browser; the default spawns xdg-open / open / start.
  open?: (url: string) => void;
  fetch?: typeof fetch;
  timeoutMs?: number;
  log?: (line: string) => void;
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => undefined).unref();
  } catch {
    // the URL is printed as well
  }
}

// Listens on 127.0.0.1 for the browser redirect, trades the grant code for tokens, returns the config.
export async function login(opts: LoginOptions): Promise<Config> {
  const agent = opts.agent ?? defaultAgentName();
  if (!ID_RE.test(agent)) throw new Error("agent name must match " + ID_RE.source);
  if (opts.org !== undefined && !ID_RE.test(opts.org)) throw new Error("org id must match " + ID_RE.source);
  const nonce = randomBytes(16).toString("base64url");
  const log = opts.log ?? (() => undefined);

  const server: Server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("could not bind a local port");

  const q = new URLSearchParams({ port: String(address.port), nonce, agent });
  if (opts.org) q.set("org", opts.org);
  const startUrl = `${opts.baseUrl.replace(/\/+$/, "")}/v1/auth/start?${q}`;
  let started = false;

  const grant = new Promise<Grant>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("login timed out; run meshpoint login again")), opts.timeoutMs ?? LOGIN_TIMEOUT_MS);
    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const reply = (status: number, body: string) => {
        res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(`<!doctype html><meta charset="utf-8"><title>Meshpoint</title><body style="font-family:system-ui;padding:3rem"><p>${body}</p></body>`);
      };
      // The browser is sent to this local page first, so the nonce never sits in a process argument
      // list; the page redirects once to the platform and then goes away.
      if (url.pathname === "/start" && !started) {
        started = true;
        res.writeHead(302, { location: startUrl, "cache-control": "no-store" });
        return res.end();
      }
      if (url.pathname !== "/callback" || url.searchParams.get("nonce") !== nonce) return reply(404, "Not found.");
      const error = url.searchParams.get("error");
      if (error) {
        reply(400, `Login failed: ${escapeHtml(error)} ${escapeHtml(url.searchParams.get("error_description") ?? "")}`);
        clearTimeout(timer);
        reject(new Error(`login failed: ${error} ${url.searchParams.get("error_description") ?? ""}`.trim()));
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) return reply(400, "Missing code.");
      api<Grant>(opts.baseUrl, "POST", "/v1/auth/exchange", { body: { code, nonce }, fetch: opts.fetch }).then(
        (g) => {
          reply(200, `Logged in to Meshpoint as ${escapeHtml(g.email)} (org ${escapeHtml(g.org_name)}). You can close this tab.`);
          clearTimeout(timer);
          resolve(g);
        },
        (err: unknown) => {
          reply(502, `Login failed: ${escapeHtml(err instanceof Error ? err.message : String(err))}`);
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
  });

  log(`Open this URL to log in (a browser should open):\n  ${startUrl}`);
  (opts.open ?? openBrowser)(`http://127.0.0.1:${address.port}/start`);
  try {
    return configFromGrant(opts.baseUrl, await grant);
  } finally {
    server.close();
  }
}

// Device-code login for hosts without a browser (cloud agents, SSH sessions). The platform mints a
// short code the user approves in the console; the CLI polls until the grant is ready.
export interface DeviceStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface DeviceLoginOptions {
  baseUrl: string;
  agent?: string;
  fetch?: typeof fetch;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  host?: string;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function deviceLogin(opts: DeviceLoginOptions): Promise<Config> {
  const agent = opts.agent ?? defaultAgentName();
  if (!ID_RE.test(agent)) throw new Error("agent name must match " + ID_RE.source);
  const log = opts.log ?? (() => undefined);
  const sleep = opts.sleep ?? wait;
  const start = await api<DeviceStart>(opts.baseUrl, "POST", "/v1/auth/device", { body: { agent, hostname: opts.host ?? hostname() }, fetch: opts.fetch });
  log(`Open ${start.verification_uri_complete}`);
  log(`or go to ${start.verification_uri} and enter ${start.user_code}`);
  log(`Waiting for approval (expires in ${Math.max(1, Math.round(start.expires_in / 60))} min)…`);
  let interval = Math.max(1, start.interval) * 1000;
  let waited = 0;
  while (waited < start.expires_in * 1000) {
    await sleep(interval);
    waited += interval;
    try {
      const g = await api<Grant>(opts.baseUrl, "POST", "/v1/auth/device/token", { body: { device_code: start.device_code }, fetch: opts.fetch });
      return configFromGrant(opts.baseUrl, g);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 428) continue;
        if (err.status === 429) {
          interval += 5000;
          continue;
        }
        if (err.status === 403) throw new Error("login denied in the console");
        if (err.status === 410) throw new Error("code expired, run meshpoint login again");
        throw err;
      }
      // Network trouble: slow down and keep polling until the code expires.
      interval += 5000;
    }
  }
  throw new Error("code expired, run meshpoint login again");
}

// A browser can plausibly open: a graphical session, macOS or Windows, and not an SSH or CI shell.
export function canOpenBrowser(env: Environment = process.env, platform: NodeJS.Platform = process.platform): boolean {
  if (env.CI) return false;
  if (env.SSH_CONNECTION || env.SSH_TTY) return false;
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY || platform === "darwin" || platform === "win32");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

// Refreshes the agent token when it has under a day left, or always with `force` (after a 401: the
// org key rotated or the token was cut short). Returns the config to use; saves it when renewed.
export async function freshConfig(config: Config, opts: { now?: number; force?: boolean; fetch?: typeof fetch; env?: Environment; home?: string } = {}): Promise<Config> {
  if (!config.refresh) return config;
  const now = opts.now ?? Date.now();
  if (!opts.force && config.exp !== undefined && config.exp - now / 1000 > REFRESH_WHEN_LEFT_S) return config;
  const g = await api<Grant>(config.baseUrl, "POST", "/v1/auth/refresh", { body: { refresh: config.refresh }, fetch: opts.fetch });
  const next = configFromGrant(config.baseUrl, g);
  saveConfig(next, opts.env, opts.home);
  return next;
}
