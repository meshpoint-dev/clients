import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverSessions } from "../src/import/discover.js";
import { consolidatePrompt, parseMerged, parseProposed, parseProposedWith, prune, renderTranscript, sessionPrompt, HEAD_CHARS, TAIL_CHARS } from "../src/import/distill.js";
import { renderReport } from "../src/import/report.js";
import { importOffer } from "../src/import/offer.js";
import { applyProposalFile, importSessions, readProposal } from "../src/import/run.js";
import { readFileSync } from "node:fs";
import { jsonBlock, type Runner } from "../src/import/runner.js";

let home: string;
const line = (o: unknown) => JSON.stringify(o);

function write(rel: string, content: string) {
  const p = path.join(home, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content);
}

// One session per harness store, all pointing at /work/web except the one with a dead cwd.
function seedStores() {
  write(
    ".claude/projects/-work-web/s-cc.jsonl",
    [
      line({ type: "user", sessionId: "s-cc", cwd: "/work/web", gitBranch: "feature/x", timestamp: "2026-11-20T10:00:00Z", message: { content: "add tests" } }),
      line({ type: "assistant", sessionId: "s-cc", cwd: "/work/web", gitBranch: "feature/x", timestamp: "2026-11-20T10:01:00Z", message: { content: [{ type: "text", text: "Added." }, { type: "tool_use", input: { file_path: "/work/web/tests/a.test.ts" } }] } }),
    ].join("\n"),
  );
  write(
    ".codex/sessions/2026/11/19/rollout-2026-11-19T10-00-00-abc.jsonl",
    [
      line({ type: "session_meta", payload: { id: "s-codex", cwd: "/work/web", timestamp: "2026-11-19T10:00:00Z", git: { branch: "master" } } }),
      line({ timestamp: "2026-11-19T10:00:05Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "fix lint" }] } }),
      line({ timestamp: "2026-11-19T10:00:09Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Lint fixed." }] } }),
    ].join("\n"),
  );
  write(
    ".pi/agent/sessions/--work-web--/2026-11-18T10-00-00-000Z_s-pi.jsonl",
    [
      line({ type: "session", version: 3, id: "s-pi", timestamp: "2026-11-18T10:00:00.000Z", cwd: "/work/web" }),
      line({ type: "message", id: "m1", timestamp: "2026-11-18T10:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "explain the build" }] } }),
      line({ type: "message", id: "m2", timestamp: "2026-11-18T10:00:05.000Z", message: { role: "assistant", content: [{ type: "text", text: "tsc builds dist." }] } }),
    ].join("\n"),
  );
  write(".local/share/opencode/storage/session/global/ses_1.json", line({ id: "ses_1", directory: "/work/web", time: { created: Date.parse("2026-11-17T10:00:00Z"), updated: Date.parse("2026-11-17T10:30:00Z") } }));
  write(".local/share/opencode/storage/message/ses_1/msg_1.json", line({ id: "msg_1", sessionID: "ses_1", role: "user", time: { created: 1 } }));
  write(".local/share/opencode/storage/message/ses_1/msg_2.json", line({ id: "msg_2", sessionID: "ses_1", role: "assistant", time: { created: 2 } }));
  write(".local/share/opencode/storage/part/msg_1/prt_1.json", line({ id: "prt_1", type: "text", text: "rename the module" }));
  write(".local/share/opencode/storage/part/msg_2/prt_2.json", line({ id: "prt_2", type: "text", text: "Renamed." }));
  const hash = createHash("sha256").update("/work/web").digest("hex");
  write(
    `.gemini/tmp/${hash}/chats/session-1.json`,
    line({ sessionId: "s-ag", projectHash: hash, startTime: "2026-11-16T10:00:00Z", lastUpdated: "2026-11-16T10:10:00Z", messages: [{ type: "info", content: "login" }, { type: "user", content: "add a flag", timestamp: "2026-11-16T10:00:00Z" }, { type: "gemini", content: "Flag added.", timestamp: "2026-11-16T10:05:00Z" }] }),
  );
  // A Codex session on another repository.
  write(
    ".codex/sessions/2026/11/19/rollout-2026-11-19T11-00-00-oth.jsonl",
    [line({ type: "session_meta", payload: { id: "s-other", cwd: "/work/other", timestamp: "2026-11-19T11:00:00Z", git: { branch: "master" } } }), line({ timestamp: "2026-11-19T11:00:05Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "other repo" }] } })].join("\n"),
  );
  // A Claude Code session whose directory no longer exists.
  write(".claude/projects/-gone-repo/s-gone.jsonl", [line({ type: "user", sessionId: "s-gone", cwd: "/gone/repo", gitBranch: "master", timestamp: "2026-11-20T10:00:00Z", message: { content: "hi" } }), line({ type: "assistant", sessionId: "s-gone", cwd: "/gone/repo", timestamp: "2026-11-20T10:00:01Z", message: { content: [{ type: "text", text: "hello" }] } })].join("\n"));
}

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "mp-import-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const projectOf = (cwd: string) => (cwd === "/work/web" ? "github.com--acme--web" : cwd === "/work/other" ? "github.com--acme--other" : null);

// Test runners quote the first user line of the transcript as evidence, as a real model would.
const quoteOf = (prompt: string) => /\[user\] ([^\n]+)/.exec(prompt)?.[1] ?? "";
const withEvidence = (items: Array<Record<string, unknown>>, prompt: string) => JSON.stringify(items.map((i) => ({ ...i, evidence: quoteOf(prompt) })));

describe("import discovery", () => {
  it("reads every store, maps directories to projects, and leaves the rest unmapped", () => {
    seedStores();
    const sessions = discoverSessions({ home, env: { PATH: "" }, projectOf });
    const byId = new Map(sessions.map((s) => [s.id, s]));
    expect([...byId.keys()].sort()).toEqual(["s-ag", "s-cc", "s-codex", "s-gone", "s-other", "s-pi", "ses_1"]);
    expect(byId.get("s-cc")).toMatchObject({ harness: "claude-code", cwd: "/work/web", branch: "feature/x", project: "github.com--acme--web" });
    expect(byId.get("s-cc")?.entries.map((e) => e.role)).toEqual(["user", "assistant"]);
    expect(byId.get("s-codex")).toMatchObject({ harness: "codex", branch: "master", project: "github.com--acme--web" });
    expect(byId.get("s-pi")).toMatchObject({ harness: "pi", branch: null, project: "github.com--acme--web" });
    expect(byId.get("s-pi")?.entries[1]?.text).toBe("tsc builds dist.");
    expect(byId.get("ses_1")).toMatchObject({ harness: "opencode", cwd: "/work/web", startedAt: Date.parse("2026-11-17T10:00:00Z") });
    expect(byId.get("ses_1")?.entries.map((e) => e.text)).toEqual(["rename the module", "Renamed."]);
    expect(byId.get("s-ag")).toMatchObject({ harness: "antigravity", cwd: "/work/web", project: "github.com--acme--web" });
    expect(byId.get("s-gone")?.project).toBeNull();
    // Newest first.
    expect(sessions[0]?.id).toMatch(/s-cc|s-gone/);
  });

  it("skips files older than the window without reading them", () => {
    seedStores();
    const old = new Date("2025-01-01T00:00:00Z");
    utimesSync(path.join(home, ".codex/sessions/2026/11/19/rollout-2026-11-19T10-00-00-abc.jsonl"), old, old);
    const ids = discoverSessions({ home, env: { PATH: "" }, projectOf, since: Date.parse("2026-06-01T00:00:00Z") }).map((s) => s.id);
    expect(ids).not.toContain("s-codex");
    expect(ids).toContain("s-cc");
  });

  it("with a project filter parses that project in full, skims unmapped sessions and skips other projects", () => {
    seedStores();
    const sessions = discoverSessions({ home, env: { PATH: "" }, projectOf, project: "github.com--acme--web" });
    const byId = new Map(sessions.map((s) => [s.id, s]));
    expect([...byId.keys()].sort()).toEqual(["s-ag", "s-cc", "s-codex", "s-gone", "s-pi", "ses_1"]);
    expect(byId.get("s-cc")?.entries.length).toBe(2);
    expect(byId.get("s-cc")?.skimmed).toBeUndefined();
    expect(byId.get("s-gone")).toMatchObject({ skimmed: true, entries: [], cwd: "/gone/repo", project: null });
    expect(byId.get("s-gone")?.endedAt).toBeGreaterThan(0);
  });
});

describe("distill", () => {
  it("renders a transcript with head and tail, builds prompts, parses proposals and merges", () => {
    const long = Array.from({ length: 3000 }, (_, i) => ({ role: "user" as const, text: `turn ${i} ${"x".repeat(40)}`, paths: [], at: i }));
    const text = renderTranscript(long);
    expect(text.length).toBeLessThan(HEAD_CHARS + TAIL_CHARS + 200);
    expect(text).toContain("characters omitted");
    const s = { harness: "claude-code" as const, file: "f", id: "sess", cwd: "/w", branch: "master", startedAt: 0, endedAt: 1, entries: [{ role: "user" as const, text: "hi", paths: ["src/a.ts"], at: 0 }], project: "p" };
    expect(sessionPrompt(s)).toContain("[user] hi\n(files: src/a.ts)");
    expect(parseProposed('```json\n[{"kind":"gotcha","title":"T","body":"B secret sk-abcdefghijklmnopqrstuvwxyz1234","key":"bad key"},{"kind":"rumor","title":"x","body":"y"},{"kind":"todo","title":"","body":"y"}]\n```', "sess")).toEqual([{ kind: "gotcha", title: "T", body: expect.stringContaining("[REDACTED:"), sessions: ["sess"] }]);
    expect(parseProposed("not json", "sess")).toEqual([]);
    // With a transcript, only items whose quote occurs in it survive; whitespace differences are forgiven.
    const transcript = "[user] run   npm test\n\n[assistant] Tests pass on node 22.";
    const checked = parseProposedWith('[{"kind":"fact","title":"A","body":"b","evidence":"run npm test"},{"kind":"fact","title":"B","body":"b","evidence":"never said"},{"kind":"fact","title":"C","body":"b"}]', "sess", transcript);
    expect(checked.items.map((i) => [i.title, i.evidence])).toEqual([["A", "run npm test"]]);
    expect(checked.unsupported).toBe(2);
    expect(parseMerged('[{"kind":"fact","title":"A","body":"b","evidence":"  kept  quote ","sessions":["a"]}]', [])[0]?.evidence).toBe("kept quote");
    const prompt = consolidatePrompt([{ kind: "fact", title: "t", body: "b", sessions: ["a"] }], [{ id: "live1", kind: "fact", title: "old", body: "x" }]);
    expect(prompt).toContain('"id":"live1"');
    const merged = parseMerged('[{"kind":"convention","title":"Tests","body":"npm test","key":"test-runner","recurring":true,"supersedes":["live1"],"sessions":["a","b"]},{"kind":"status","title":"wip","body":"x","sessions":["a"]}]', []);
    expect(merged).toEqual([{ kind: "convention", title: "Tests", body: "npm test", key: "test-runner", recurring: true, supersedes: ["live1"], sessions: ["a", "b"] }]);
    expect(parseMerged("garbage", [{ kind: "fact", title: "t", body: "b", sessions: ["a"] }, { kind: "status", title: "s", body: "b", sessions: ["a"] }])).toHaveLength(1);
    expect(jsonBlock("Here you go:\n[1,2]")).toEqual([1, 2]);
  });

  it("prunes items naming files the checkout no longer has", () => {
    const exists = (p: string) => p === "/w/src/a.ts";
    const { kept, dropped } = prune([{ kind: "fact", title: "A", body: "see src/a.ts", sessions: [] }, { kind: "fact", title: "B", body: "see src/gone.ts", sessions: [] }], "/w", exists);
    expect(kept.map((i) => [i.title, i.refs])).toEqual([["A", ["src/a.ts"]]]);
    expect(dropped.map((i) => [i.title, i.missing])).toEqual([["B", ["src/gone.ts"]]]);
  });
});

describe("import run", () => {
  it("dry-runs by default, writes proposals and a report, and uploads with provenance on --apply", async () => {
    seedStores();
    const calls: Array<{ url: string; body: any }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (url.includes("/v1/recall")) return Response.json({ project: "p", branch: "master", checkpoint: null, items: [{ id: "live-1", kind: "fact", title: "Old", body: "old", branch: "master" }], generated_at: 1, source: "do" });
      return Response.json({ count: 2, superseded: 1, accepted: 2 }, { status: 202 });
    }) as unknown as typeof fetch;
    const prompts: string[] = [];
    const runner: Runner = {
      name: "claude",
      async run(prompt) {
        prompts.push(prompt);
        if (prompt.startsWith("You merge")) return '[{"kind":"gotcha","title":"Lint needs node 22","body":"CI lint fails on node 20; see package.json","evidence":"fix lint","recurring":true,"supersedes":["live-1","nope"],"sessions":["s-codex","s-cc"]},{"kind":"fact","title":"Gone file","body":"see src/gone.ts","sessions":["s-pi"]}]';
        return withEvidence([{ kind: "gotcha", title: "Lint needs node 22", body: "CI lint fails on node 20; see package.json" }], prompt);
      },
    };
    const state = path.join(home, "state");
    const live = () => "live" as const;
    const base = { config: { baseUrl: "https://api.test", token: "tok", user: "u1" }, current: { project: "github.com--acme--web", root: "/work/web", defaultBranch: "master" }, sinceDays: 90, allRepos: false, withTurns: false, yes: false, minTurns: 1, runner, stateDir: state, home, env: { PATH: "" }, discover: (o: any) => discoverSessions({ ...o, projectOf }), now: () => Date.parse("2026-11-22T12:00:00Z"), fetch: fetchImpl, log: () => undefined, exists: (p: string) => p === "/work/web/package.json", branchState: live };
    const dry = await importSessions({ ...base, apply: false, propose: false });
    expect(dry.cancelled).toBe(false);
    expect(dry.results).toHaveLength(1);
    expect(dry.unmapped.map((s) => s.id)).toEqual(["s-gone"]);
    expect(dry.results[0]?.sessions.map((s) => s.id).sort()).toEqual(["s-ag", "s-cc", "s-codex", "s-pi", "ses_1"]);
    // Branches: feature/x from the Claude Code session, master for the rest.
    expect(dry.results[0]?.branches.map((b) => b.branch).sort()).toEqual(["feature/x", "master"]);
    const master = dry.results[0]?.branches.find((b) => b.branch === "master");
    expect(master?.items.map((i) => [i.title, i.refs, i.supersedes, i.evidence])).toEqual([["Lint needs node 22", ["package.json"], ["live-1"], "fix lint"]]);
    expect(master?.dropped.map((i) => i.title)).toEqual(["Gone file"]);
    expect(calls.filter((c) => c.url.endsWith("/v1/items"))).toHaveLength(0);
    expect(dry.itemsFiles[0]).toMatch(/github\.com--acme--web\.items\.json$/);
    const report = renderReport(dry.results, dry.unmapped, {});
    expect(report).toContain("== github.com--acme--web");
    expect(report).toContain("recurring gotchas:");
    expect(report).toContain("1 session could not be mapped");
    // Every session got its own distill call, each branch one merge call.
    expect(prompts.filter((p) => !p.startsWith("You merge"))).toHaveLength(5);
    expect(prompts.filter((p) => p.startsWith("You merge"))).toHaveLength(2);

    calls.length = 0;
    const applied = await importSessions({ ...base, apply: true, propose: false, withTurns: true });
    const puts = calls.filter((c) => c.url.endsWith("/v1/items"));
    expect(puts.length).toBeGreaterThanOrEqual(1);
    const item = puts.find((c) => c.body.branch === "master")?.body.items[0];
    expect(item).toMatchObject({ kind: "gotcha", refs: ["package.json"], supersedes: ["live-1"], created_at: Date.parse("2026-11-20T10:01:00Z") });
    expect(JSON.parse(item.provenance)).toMatchObject({ agent: expect.stringMatching(/^import:/), user: "u1" });
    expect(item.evidence).toBeUndefined();
    expect(applied.uploaded.items).toBeGreaterThan(0);
    const captures = calls.filter((c) => c.url.endsWith("/v1/capture"));
    expect(captures.map((c) => c.body.session).sort()).toEqual(["s-ag", "s-cc", "s-codex", "s-pi", "ses_1"]);
    expect(captures.find((c) => c.body.session === "s-cc")?.body.branch).toBe("feature/x");
  });

  it("uploads an edited proposal file exactly as reviewed with --apply --from", async () => {
    seedStores();
    const runner: Runner = {
      name: "claude",
      async run(prompt) {
        if (prompt.startsWith("You merge")) return '[{"kind":"gotcha","title":"Keep me","body":"see package.json","evidence":"add tests","sessions":["s-cc"]},{"kind":"fact","title":"Delete me","body":"x","sessions":["s-cc"]}]';
        return withEvidence([{ kind: "gotcha", title: "Keep me", body: "see package.json" }], prompt);
      },
    };
    const quiet = (async () => Response.json({ project: "p", branch: "master", checkpoint: null, items: [], generated_at: 1, source: "do" })) as unknown as typeof fetch;
    const base = { config: { baseUrl: "https://api.test", token: "tok", user: "u1" }, current: { project: "github.com--acme--web", root: "/work/web", defaultBranch: "master" }, sinceDays: 90, allRepos: false, withTurns: false, yes: false, minTurns: 1, runner, stateDir: path.join(home, "state"), home, env: { PATH: "" }, discover: (o: any) => discoverSessions({ ...o, projectOf }), now: () => Date.parse("2026-11-22T12:00:00Z"), fetch: quiet, log: () => undefined, exists: (p: string) => p === "/work/web/package.json", branchState: () => "live" as const };
    const dry = await importSessions({ ...base, apply: false, propose: false });
    const file = dry.itemsFiles[0]!;
    const saved = readProposal(file);
    expect([...new Set(saved.flatMap((b) => b.items.map((i) => i.title)))].sort()).toEqual(["Delete me", "Keep me"]);
    expect(saved[0]?.items[0]?.created_at).toBeGreaterThan(0);
    expect(saved[0]?.items[0]?.harnesses).toEqual(["claude-code"]);
    expect(saved.flatMap((b) => b.items).find((i) => i.title === "Keep me")?.evidence).toBe("add tests");
    // The user deletes one entry and edits another's title.
    const edited = saved.map((b) => ({ ...b, items: b.items.filter((i) => i.title !== "Delete me").map((i) => ({ ...i, title: "Kept and renamed" })) }));
    writeFileSync(file, JSON.stringify(edited));
    const calls: Array<{ url: string; body: any }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), body: init?.body ? JSON.parse(init.body as string) : undefined });
      return Response.json({ count: 1, superseded: 0 }, { status: 202 });
    }) as unknown as typeof fetch;
    const out = await applyProposalFile({ config: base.config, file, current: base.current, fetch: fetchImpl, exists: base.exists, log: () => undefined });
    expect(out.items).toBe(saved.length);
    const put = calls.find((c) => c.url.endsWith("/v1/items"))!;
    expect(put.body.items.map((i: { title: string }) => i.title)).toEqual(["Kept and renamed"]);
    expect(put.body.items[0]).toMatchObject({ kind: "gotcha", refs: ["package.json"], created_at: Date.parse("2026-11-20T10:01:00Z") });
    expect(JSON.parse(put.body.items[0].provenance).agent).toBe("import:claude-code");
    writeFileSync(file, JSON.stringify([{ branch: "master", items: [{ kind: "status", title: "no", body: "x" }] }]));
    expect(() => readProposal(file)).toThrow(/kind must be one of/);
    writeFileSync(file, "{}");
    expect(() => readProposal(file)).toThrow(/expected an array/);
    expect(readFileSync(file, "utf8")).toBe("{}");
  });

  it("sends the proposal to the platform with --propose and reports the review url", async () => {
    seedStores();
    const calls: Array<{ url: string; body: any }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (url.includes("/v1/recall")) return Response.json({ project: "p", branch: "master", checkpoint: null, items: [], generated_at: 1, source: "do" });
      if (url.endsWith("/v1/imports")) return Response.json({ id: "imp_abc123def456", url: "https://console.test/projects/github.com--acme--web/imports/imp_abc123def456" }, { status: 201 });
      return Response.json({ count: 1, superseded: 0 }, { status: 202 });
    }) as unknown as typeof fetch;
    const runner: Runner = { name: "claude", run: async (p) => (p.startsWith("You merge") ? '[{"kind":"fact","title":"F","body":"b","evidence":"add tests","sessions":["s-cc"]}]' : withEvidence([{ kind: "fact", title: "F", body: "b" }], p)) };
    const out = await importSessions({ config: { baseUrl: "https://api.test", token: "tok", user: "u1" }, current: { project: "github.com--acme--web", root: "/work/web", defaultBranch: "master" }, sinceDays: 90, allRepos: false, withTurns: false, apply: false, propose: true, yes: false, minTurns: 1, runner, stateDir: path.join(home, "state"), home, env: { PATH: "" }, discover: (o: any) => discoverSessions({ ...o, projectOf }), now: () => Date.parse("2026-11-22T12:00:00Z"), fetch: fetchImpl, log: () => undefined, exists: () => false, branchState: () => "live" as const });
    expect(out.proposals).toEqual([{ project: "github.com--acme--web", id: "imp_abc123def456", url: "https://console.test/projects/github.com--acme--web/imports/imp_abc123def456" }]);
    const sent = calls.find((c) => c.url.endsWith("/v1/imports"))!;
    expect(sent.body.project).toBe("github.com--acme--web");
    expect(sent.body.branches.flatMap((b: any) => b.items).length).toBeGreaterThan(0);
    expect(sent.body.branches.flatMap((b: any) => b.items).every((i: any) => typeof i.evidence === "string")).toBe(true);
    expect(sent.body.report).toContain("== github.com--acme--web");
    expect(calls.filter((c) => c.url.endsWith("/v1/items"))).toHaveLength(0);
  });

  it("reuses cached per-session proposals on a rerun and distills again with --fresh", async () => {
    seedStores();
    let sessionCalls = 0;
    const runner: Runner = {
      name: "claude",
      async run(prompt) {
        if (prompt.startsWith("You merge")) return '[{"kind":"fact","title":"F","body":"b","evidence":"add tests","sessions":["s-cc"]}]';
        sessionCalls++;
        return withEvidence([{ kind: "fact", title: "F", body: "b" }], prompt);
      },
    };
    const quiet = (async () => Response.json({ project: "p", branch: "master", checkpoint: null, items: [], generated_at: 1, source: "do" })) as unknown as typeof fetch;
    const logs: string[] = [];
    const base = { config: { baseUrl: "https://api.test", token: "tok", user: "u1" }, current: { project: "github.com--acme--web", root: "/work/web", defaultBranch: "master" }, sinceDays: 90, allRepos: false, withTurns: false, apply: false, propose: false, yes: false, minTurns: 1, runner, stateDir: path.join(home, "state"), home, env: { PATH: "" }, discover: (o: any) => discoverSessions({ ...o, projectOf }), now: () => Date.parse("2026-11-22T12:00:00Z"), fetch: quiet, log: (l: string) => logs.push(l), exists: () => false, branchState: () => "live" as const };
    await importSessions(base);
    expect(sessionCalls).toBe(5);
    const cacheDir = path.join(home, "state", "import", "cache");
    expect(readFileSync(path.join(cacheDir, "claude-code-s-cc.json"), "utf8")).toContain('"items"');
    await importSessions(base);
    expect(sessionCalls).toBe(5);
    expect(logs.filter((l) => l.includes("(cached)"))).toHaveLength(5);
    // A changed transcript is distilled again.
    writeFileSync(path.join(home, ".claude/projects/-work-web/s-cc.jsonl"), readFileSync(path.join(home, ".claude/projects/-work-web/s-cc.jsonl"), "utf8") + "\n" + line({ type: "user", sessionId: "s-cc", cwd: "/work/web", timestamp: "2026-11-20T10:02:00Z", message: { content: "and lint" } }));
    await importSessions(base);
    expect(sessionCalls).toBe(6);
    await importSessions({ ...base, fresh: true });
    expect(sessionCalls).toBe(11);
  });

  it("folds proposals from gone or merged branches into the default branch and reports it", async () => {
    seedStores();
    const runner: Runner = { name: "claude", run: async (p) => (p.startsWith("You merge") ? '[{"kind":"fact","title":"F","body":"b","evidence":"add tests","sessions":["s-cc"]}]' : withEvidence([{ kind: "fact", title: "F", body: "b" }], p)) };
    const quiet = (async () => Response.json({ project: "p", branch: "master", checkpoint: null, items: [], generated_at: 1, source: "do" })) as unknown as typeof fetch;
    const asked: string[] = [];
    const out = await importSessions({ config: { baseUrl: "https://api.test", token: "tok", user: "u1" }, current: { project: "github.com--acme--web", root: "/work/web", defaultBranch: "master" }, sinceDays: 90, allRepos: false, withTurns: false, apply: false, propose: false, yes: false, minTurns: 1, runner, stateDir: path.join(home, "state"), home, env: { PATH: "" }, discover: (o: any) => discoverSessions({ ...o, projectOf }), now: () => Date.parse("2026-11-22T12:00:00Z"), fetch: quiet, log: () => undefined, exists: () => false, branchState: (root, branch) => (asked.push(`${root}:${branch}`), "merged") });
    expect(asked).toEqual(["/work/web:feature/x"]);
    expect(out.results[0]?.branches.map((b) => b.branch)).toEqual(["master"]);
    expect(out.results[0]?.folded).toEqual([{ branch: "feature/x", into: "master", why: "merged" }]);
    expect(renderReport(out.results, [], {})).toContain("folded into master: feature/x (merged)");
  });

  it("offers an import after connect when the repository has past sessions", () => {
    seedStores();
    const now = () => Date.parse("2026-11-22T12:00:00Z");
    const discover = (o: any) => discoverSessions({ ...o, projectOf });
    const repo = { project: "github.com--acme--web", root: "/work/web", branch: "master" };
    // Seeded sessions have two turns each; the offer wants six.
    expect(importOffer({ repo, env: { PATH: "" }, runner: "claude", home, now, discover })).toBeNull();
    write(".claude/projects/-work-web/s-long.jsonl", Array.from({ length: 8 }, (_, i) => line({ type: i % 2 ? "assistant" : "user", sessionId: "s-long", cwd: "/work/web", gitBranch: "master", timestamp: `2026-11-21T10:0${i}:00Z`, message: { content: i % 2 ? [{ type: "text", text: `reply ${i}` }] : `ask ${i}` } })).join("\n"));
    const text = importOffer({ repo, env: { PATH: "" }, runner: "claude", home, now, discover });
    expect(text).toBe("1 past session found for this repository (claude-code 1), 2026-11-21 to 2026-11-21.\nDistill them with your claude into a proposal for review: meshpoint import sessions --propose (about 1 minute).");
    expect(importOffer({ repo, env: { PATH: "" }, runner: null, home, now, discover })).toContain("No agent CLI");
    expect(importOffer({ repo: null, env: { PATH: "" }, runner: "claude", home, now, discover })).toBeNull();
  });

  const builtCli = path.resolve("dist/bin.js");
  it.skipIf(!existsSync(builtCli))("prints the import usage on --help without a login and exits 0", () => {
    const out = execFileSync("node", [builtCli, "import", "sessions", "--help"], { env: { PATH: process.env.PATH ?? "", XDG_CONFIG_HOME: home }, encoding: "utf8" });
    expect(out).toContain("import sessions [--since <days>]");
    expect(out).toContain("--fresh");
  });

  it("asks before going past 90 days or across repos, and stops on no", async () => {
    seedStores();
    const asked: string[] = [];
    const runner: Runner = { name: "claude", run: async () => "[]" };
    const out = await importSessions({ config: { baseUrl: "https://api.test", token: "tok" }, current: null, sinceDays: 365, allRepos: true, withTurns: false, apply: false, propose: false, yes: false, minTurns: 1, runner, stateDir: path.join(home, "state"), home, env: { PATH: "" }, discover: (o: any) => discoverSessions({ ...o, projectOf }), now: () => Date.parse("2026-11-22T12:00:00Z"), log: () => undefined, confirm: async (q) => (asked.push(q), false) });
    expect(out.cancelled).toBe(true);
    expect(asked).toHaveLength(1);
  });
});
