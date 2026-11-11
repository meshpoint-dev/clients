import { describe, expect, it, vi } from "vitest";
import { canOpenBrowser, deviceLogin } from "../src/control.js";

const start = { device_code: "dev-1", user_code: "ABCD-EFGH", verification_uri: "https://app.test/device", verification_uri_complete: "https://app.test/device?code=ABCD-EFGH", expires_in: 900, interval: 5 };
const grant = { token: "tok", exp: 1_900_000_000, refresh: "ref", org: "o_1", org_name: "acme", user: "u_1", email: "a@acme.test", agent: "cli-box" };

function fake(tokenResponses: Array<() => Response>) {
  const bodies: unknown[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    bodies.push(init?.body ? JSON.parse(String(init.body)) : undefined);
    if (url.endsWith("/v1/auth/device")) return Response.json(start, { status: 201 });
    if (url.endsWith("/v1/auth/device/token")) return (tokenResponses.shift() ?? (() => Response.json({ error: "unexpected" }, { status: 500 })))();
    return new Response("not found", { status: 404 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, bodies };
}

const pending = () => Response.json({ error: "authorization_pending" }, { status: 428 });

describe("deviceLogin", () => {
  it("prints the approval lines, polls at the interval and returns the grant", async () => {
    const { fetchImpl, bodies } = fake([pending, pending, () => Response.json(grant)]);
    const lines: string[] = [];
    const sleeps: number[] = [];
    const config = await deviceLogin({ baseUrl: "https://api.test", agent: "cli-box", host: "box", fetch: fetchImpl, log: (l) => lines.push(l), sleep: async (ms) => void sleeps.push(ms) });
    expect(lines).toEqual(["Open https://app.test/device?code=ABCD-EFGH", "or go to https://app.test/device and enter ABCD-EFGH", "Waiting for approval (expires in 15 min)…"]);
    expect(bodies[0]).toEqual({ agent: "cli-box", hostname: "box" });
    expect(bodies.slice(1)).toEqual([{ device_code: "dev-1" }, { device_code: "dev-1" }, { device_code: "dev-1" }]);
    expect(sleeps).toEqual([5000, 5000, 5000]);
    expect(config).toMatchObject({ baseUrl: "https://api.test", token: "tok", refresh: "ref", org: "o_1", orgName: "acme", email: "a@acme.test", agent: "cli-box" });
  });

  it("backs off on 429 and network errors", async () => {
    const { fetchImpl } = fake([
      () => Response.json({ error: "slow_down" }, { status: 429 }),
      () => {
        throw new Error("ECONNRESET");
      },
      () => Response.json(grant),
    ]);
    const sleeps: number[] = [];
    await deviceLogin({ baseUrl: "https://api.test", agent: "cli-box", fetch: fetchImpl, sleep: async (ms) => void sleeps.push(ms) });
    expect(sleeps).toEqual([5000, 10000, 15000]);
  });

  it("stops on denial and on expiry", async () => {
    const denied = fake([() => Response.json({ error: "access_denied" }, { status: 403 })]);
    await expect(deviceLogin({ baseUrl: "https://api.test", agent: "cli-box", fetch: denied.fetchImpl, sleep: async () => undefined })).rejects.toThrow(/denied/);
    const expired = fake([() => Response.json({ error: "expired_token" }, { status: 410 })]);
    await expect(deviceLogin({ baseUrl: "https://api.test", agent: "cli-box", fetch: expired.fetchImpl, sleep: async () => undefined })).rejects.toThrow(/code expired, run meshpoint login again/);
    // Pending past the server's expiry also ends with the expiry message.
    const forever = fake(Array.from({ length: 200 }, () => pending));
    await expect(deviceLogin({ baseUrl: "https://api.test", agent: "cli-box", fetch: forever.fetchImpl, sleep: async () => undefined })).rejects.toThrow(/code expired/);
  });
});

describe("canOpenBrowser", () => {
  it("needs a display or a desktop OS and no SSH or CI", () => {
    expect(canOpenBrowser({ DISPLAY: ":0" }, "linux")).toBe(true);
    expect(canOpenBrowser({ WAYLAND_DISPLAY: "wayland-0" }, "linux")).toBe(true);
    expect(canOpenBrowser({}, "linux")).toBe(false);
    expect(canOpenBrowser({}, "darwin")).toBe(true);
    expect(canOpenBrowser({}, "win32")).toBe(true);
    expect(canOpenBrowser({ DISPLAY: ":0", SSH_CONNECTION: "1 2 3 4" }, "linux")).toBe(false);
    expect(canOpenBrowser({ CI: "true" }, "darwin")).toBe(false);
  });
});
