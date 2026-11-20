import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configPath, loadConfig, saveConfig } from "../src/config.js";
import { defaultAgentName, freshConfig, login, REFRESH_WHEN_LEFT_S } from "../src/control.js";

// A stand-in platform: start redirects straight to the CLI's callback, exchange and refresh issue grants.
let server: Server;
let baseUrl: string;
const seen: { start?: URL; exchanged: string[]; exchangedNonce: string[]; refreshed: string[]; opened: string[] } = { exchanged: [], exchangedNonce: [], refreshed: [], opened: [] };

function grant(suffix: string) {
  return { token: `tok-${suffix}`, exp: Math.floor(Date.now() / 1000) + 7 * 86_400, refresh: "ref-1", org: "o_1", org_name: "aaron", user: "u_1", email: "a@example.com", agent: "cli-test" };
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (url.pathname === "/v1/auth/start") {
        seen.start = url;
        const target = url.searchParams.get("nonce") === "deny" ? "error=access_denied&error_description=nope" : "code=grant-1";
        res.writeHead(302, { location: `http://127.0.0.1:${url.searchParams.get("port")}/callback?nonce=${url.searchParams.get("nonce")}&${target}` });
        return res.end();
      }
      if (url.pathname === "/v1/auth/exchange") {
        seen.exchanged.push(JSON.parse(body).code);
        seen.exchangedNonce.push(JSON.parse(body).nonce);
        res.writeHead(201, { "content-type": "application/json" });
        return res.end(JSON.stringify(grant("login")));
      }
      if (url.pathname === "/v1/auth/refresh") {
        seen.refreshed.push(JSON.parse(body).refresh);
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(grant("refreshed")));
      }
      res.writeHead(404);
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => server.close());

// The "browser": follow the start redirect to the CLI's local listener.
const browser = (url: string) => {
  seen.opened.push(url);
  void fetch(url, { redirect: "follow" }).catch(() => undefined);
};

describe("login", () => {
  it("opens the start URL, receives the grant on the local port and exchanges it", async () => {
    const config = await login({ baseUrl, agent: "cli-test", open: browser, timeoutMs: 5000 });
    expect(config).toMatchObject({ baseUrl, token: "tok-login", refresh: "ref-1", org: "o_1", orgName: "aaron", email: "a@example.com", agent: "cli-test" });
    expect(seen.start?.searchParams.get("agent")).toBe("cli-test");
    expect(Number(seen.start?.searchParams.get("port"))).toBeGreaterThan(1023);
    expect(seen.exchanged).toEqual(["grant-1"]);
    expect(seen.exchangedNonce[0]).toBe(seen.start?.searchParams.get("nonce"));
    expect(seen.opened[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/start$/);
    // The local start page serves once; a second visitor gets nothing.
    expect((await fetch(seen.opened[0]!, { redirect: "manual" }).catch(() => ({ status: 0 }))).status).toBe(0);
  });

  it("reports a denied login", async () => {
    // The nonce is random; drive the denial through the agent name the fake server keys on instead.
    const denied = login({
      baseUrl,
      agent: "cli-test",
      open: (url) => {
        // Follow the local start page by hand: swap the nonce for "deny" on the way to the fake
        // server, then put the real one back on the redirect the listener receives.
        void fetch(url, { redirect: "manual" }).then(async (first) => {
          const start = new URL(first.headers.get("location")!);
          const real = start.searchParams.get("nonce")!;
          start.searchParams.set("nonce", "deny");
          const second = await fetch(start.toString(), { redirect: "manual" });
          const loc = new URL(second.headers.get("location")!);
          loc.searchParams.set("nonce", real);
          return fetch(loc.toString()).catch(() => undefined);
        });
      },
      timeoutMs: 5000,
    });
    await expect(denied).rejects.toThrow(/access_denied/);
  });

  it("rejects unsafe agent names and sanitizes the default", () => {
    expect(defaultAgentName("my host!")).toBe("cli-my-host-");
    return expect(login({ baseUrl, agent: "bad name", open: () => undefined })).rejects.toThrow(/agent name/);
  });
});

describe("freshConfig", () => {
  const home = mkdtempSync(path.join(tmpdir(), "meshpoint-home-"));
  const env = { XDG_CONFIG_HOME: path.join(home, "cfg") };
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it("leaves tokens with more than a day left alone and pasted tokens untouched", async () => {
    const far = { baseUrl, token: "t", refresh: "ref-1", exp: Math.floor(Date.now() / 1000) + REFRESH_WHEN_LEFT_S + 60 };
    expect(await freshConfig(far, { env, home })).toBe(far);
    const pasted = { baseUrl, token: "t" };
    expect(await freshConfig(pasted, { env, home })).toBe(pasted);
    expect(seen.refreshed).toEqual([]);
  });

  it("refreshes a token with under a day left and saves the result", async () => {
    const soon = { baseUrl, token: "old", refresh: "ref-1", exp: Math.floor(Date.now() / 1000) + 3600 };
    saveConfig(soon, env, home);
    const next = await freshConfig(soon, { env, home });
    expect(next.token).toBe("tok-refreshed");
    expect(seen.refreshed).toEqual(["ref-1"]);
    expect(JSON.parse(readFileSync(configPath(env, home), "utf8")).token).toBe("tok-refreshed");
  });
});

describe("loadConfig", () => {
  const home = mkdtempSync(path.join(tmpdir(), "mp-cfg-"));
  const env = { XDG_CONFIG_HOME: path.join(home, "cfg") };
  saveConfig({ baseUrl: "https://api.example", token: "file-token", refresh: "file-refresh" }, env, home);
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it("never sends the file's credentials to an environment-supplied URL", () => {
    expect(loadConfig(env, home)).toMatchObject({ baseUrl: "https://api.example", token: "file-token", refresh: "file-refresh" });
    expect(loadConfig({ ...env, MESHPOINT_BASE_URL: "https://attacker.example" }, home)).toBeNull();
    expect(loadConfig({ ...env, MESHPOINT_BASE_URL: "https://api.example" }, home)).toMatchObject({ token: "file-token", refresh: "file-refresh" });
    expect(loadConfig({ ...env, MESHPOINT_BASE_URL: "https://other.example", MESHPOINT_TOKEN: "env-token" }, home)).toEqual({ baseUrl: "https://other.example", token: "env-token" });
  });

  it("refuses plain http except to the local machine", () => {
    expect(loadConfig({ ...env, MESHPOINT_BASE_URL: "http://attacker.example", MESHPOINT_TOKEN: "t" }, home)).toBeNull();
    expect(loadConfig({ ...env, MESHPOINT_BASE_URL: "http://localhost:8787", MESHPOINT_TOKEN: "t" }, home)).toEqual({ baseUrl: "http://localhost:8787", token: "t" });
  });
});
