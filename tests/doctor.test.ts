import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { saveConfig } from "../src/config.js";
import { agoText, renderDoctor, runDoctor } from "../src/doctor.js";

const home = mkdtempSync(path.join(tmpdir(), "mp-doctor-"));
const env = { HOME: home, PATH: "" };
const repo = path.join(home, "repo");
const now = 1_800_000_000_000;
afterAll(() => rmSync(home, { recursive: true, force: true }));

mkdirSync(repo);
execFileSync("git", ["init", "-q", "-b", "master"], { cwd: repo });
execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/web.git"], { cwd: repo });
execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@x", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });

function fakeFetch(opts: { me?: number; capture?: number | null; projectStatus?: number } = {}) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/v1/me")) {
      if (opts.me === 401) return Response.json({ error: "unauthorized" }, { status: 401 });
      return Response.json({ user: { id: "u_1", email: "a@acme.test", name: null }, org: { id: "o_1", name: "acme", role: "owner" }, orgs: [] });
    }
    if (url.includes("/v1/project?project=github.com--acme--web")) {
      if (opts.projectStatus) return Response.json({ error: "no" }, { status: opts.projectStatus });
      return Response.json({ project: "github.com--acme--web", last_capture_at: opts.capture === undefined ? now - 120_000 : opts.capture, items: 6, branches: [], presence: [], captures_1h: 1 });
    }
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("doctor", () => {
  it("fails without a login or a harness and says what to run", async () => {
    const report = await runDoctor({ env, home, cwd: home, fetch: fakeFetch(), now });
    expect(report.ok).toBe(false);
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    expect(byId.config).toMatchObject({ status: "fail" });
    expect(byId.config?.detail).toMatch(/run meshpoint login/);
    expect(byId.repo).toMatchObject({ status: "fail" });
    expect(byId.harness).toMatchObject({ status: "fail" });
    expect(byId.spool).toMatchObject({ status: "ok" });
    expect(renderDoctor(report)).toMatch(/^✗ config/m);
    expect(renderDoctor(report)).toContain("not ready");
  });

  it("passes with a login, a repo, a connected harness and a recent capture", async () => {
    saveConfig({ baseUrl: "https://api.test", token: "tok" }, env, home);
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "meshpoint tap claude-code" }] }] } }));
    mkdirSync(path.join(home, ".cursor"), { recursive: true });
    const report = await runDoctor({ env, home, cwd: repo, fetch: fakeFetch(), now });
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    expect(byId.token).toMatchObject({ status: "ok", detail: "a@acme.test, org acme (owner)" });
    expect(byId.repo).toMatchObject({ status: "ok", detail: "github.com--acme--web on master" });
    expect(byId["harness:claude-code"]).toMatchObject({ status: "ok", detail: "connected in user scope" });
    expect(byId["harness:cursor"]).toMatchObject({ status: "fail", detail: "found but not connected; run meshpoint connect cursor" });
    expect(byId.capture).toMatchObject({ status: "ok", detail: "last capture 2 min ago, 6 items" });
    expect(report.ok).toBe(false);

    rmSync(path.join(home, ".cursor"), { recursive: true });
    const clean = await runDoctor({ env, home, cwd: repo, fetch: fakeFetch(), now });
    expect(clean.ok).toBe(true);
    expect(renderDoctor(clean)).toMatch(/\nready$/);
  });

  it("treats a project without captures as information, not failure", async () => {
    const never = await runDoctor({ env, home, cwd: repo, fetch: fakeFetch({ capture: null }), now });
    expect(never.checks.find((c) => c.id === "capture")).toMatchObject({ status: "info", detail: expect.stringMatching(/no capture yet/) });
    expect(never.checks.filter((c) => c.status === "fail")).toEqual([]);
    const missing = await runDoctor({ env, home, cwd: repo, fetch: fakeFetch({ projectStatus: 404 }), now });
    expect(missing.checks.find((c) => c.id === "capture")).toMatchObject({ status: "info" });
    expect(renderDoctor(missing)).toMatch(/^· capture/m);
  });

  it("reports a rejected token", async () => {
    const report = await runDoctor({ env, home, cwd: repo, fetch: fakeFetch({ me: 401 }), now });
    expect(report.checks.find((c) => c.id === "token")).toMatchObject({ status: "fail", detail: expect.stringMatching(/run meshpoint login/) });
    expect(report.checks.find((c) => c.id === "capture")).toBeUndefined();
  });

  it("formats ages", () => {
    expect(agoText(now - 5000, now)).toBe("5s ago");
    expect(agoText(now - 3 * 3_600_000, now)).toBe("3 h ago");
    expect(agoText(now - 5 * 86_400_000, now)).toBe("5 d ago");
  });
});
