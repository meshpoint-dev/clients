import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Checkpoints } from "../src/checkpoints.js";
import { connectMcp, installMcpEntry, MCP_ENTRY, removeMcpEntry } from "../src/mcp/connect.js";
import { McpServer } from "../src/mcp/server.js";
import { meshpointTools } from "../src/mcp/tools.js";
import { Spool } from "../src/spool.js";
import { Tap } from "../src/tap.js";
import { Touched } from "../src/touched.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "mp-mcp-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const calls: Array<{ method: string; url: string; body?: unknown }> = [];
const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const body = init?.body ? JSON.parse(init.body as string) : undefined;
  calls.push({ method: init?.method ?? "GET", url, body });
  if (url.includes("/v1/recall")) {
    return Response.json({
      project: "p",
      branch: "master",
      checkpoint: null,
      items: [{ id: "d1234567-0000", kind: "decision", title: "Use KV", body: "edge speed", branch: "master", created_at: 1, confirmations: 0, retracted: 0, provenance: "", refs: [], paths: [], commit_sha: "", state: "ok", verified_at: 0, stale_count: 0, key: "", superseded_by: "", confirmed_at: 0 }],
      generated_at: 1,
      source: "kv",
    });
  }
  if (url.includes("/v1/presence")) return Response.json({ presence: [] });
  if (url.includes("/v1/context")) return Response.json({ items: [], presence: [{ agent: "codex", user: "sam", branch: "master", paths: ["src/a.ts"], updated_at: 999_000 }] });
  if (url.includes("/retract") || url.includes("/confirm")) return Response.json({ found: true }, { status: 202 });
  if (url.includes("/verify")) return Response.json({ applied: 0 });
  if (url.endsWith("/v1/items") && init?.method === "POST") return Response.json({ count: body.items.length, superseded: 0 });
  return Response.json({ accepted: 0 }, { status: 202 });
});

function server(opts: { tap?: boolean } = {}): McpServer {
  const config = { baseUrl: "https://api.test", token: "tok" };
  const repo = { project: "p", branch: "master", root: dir };
  const tap = opts.tap === false ? null : new Tap({ config, repo, session: "s", spool: new Spool(dir), checkpoints: new Checkpoints(dir), now: () => 1_000_000, fetch: fetchImpl as unknown as typeof fetch, presenceWaitMs: 1 });
  return new McpServer({ name: "meshpoint", version: "t", instructions: "do", tools: meshpointTools({ tap, cwd: dir, config: async () => config, checkpoints: new Checkpoints(dir), touched: new Touched(dir), fetch: fetchImpl as unknown as typeof fetch }) });
}

async function roundtrip(s: McpServer, lines: string[]): Promise<Array<Record<string, unknown>>> {
  const input = new PassThrough();
  const output = new PassThrough();
  const done = s.serve(input, output);
  for (const l of lines) input.write(`${l}\n`);
  input.end();
  await done;
  output.end();
  let text = "";
  for await (const chunk of output) text += chunk;
  return text.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
}

const rpc = (id: number, method: string, params?: unknown) => JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });

describe("mcp server", () => {
  it("negotiates the protocol, lists five tools, ignores notifications, answers ping", async () => {
    const out = await roundtrip(server(), [rpc(1, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } }), JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), rpc(2, "ping"), rpc(3, "tools/list")]);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ id: 1, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "meshpoint", version: "t" }, instructions: "do" } });
    expect(out[1]).toEqual({ jsonrpc: "2.0", id: 2, result: {} });
    const tools = (out[2]!.result as { tools: Array<{ name: string; inputSchema: { type: string } }> }).tools;
    expect(tools.map((t) => t.name)).toEqual(["meshpoint_recall", "meshpoint_file_context", "meshpoint_items_put", "meshpoint_items_retract", "meshpoint_items_confirm"]);
    expect(tools.every((t) => t.inputSchema.type === "object")).toBe(true);
    const unknown = await roundtrip(server(), [rpc(4, "initialize", { protocolVersion: "1999-01-01" })]);
    expect(unknown[0]).toMatchObject({ result: { protocolVersion: "2025-06-18" } });
  });

  it("answers errors for bad JSON, unknown methods and unknown tools", async () => {
    const out = await roundtrip(server(), ["{nope", rpc(1, "resources/list"), rpc(2, "tools/call", { name: "nothing", arguments: {} })]);
    expect(out[0]).toMatchObject({ id: null, error: { code: -32700 } });
    expect(out[1]).toMatchObject({ id: 1, error: { code: -32601 } });
    expect(out[2]).toMatchObject({ id: 2, error: { code: -32602, message: "unknown tool: nothing" } });
  });

  it("recall renders the inject, file context the notice, and item writes reach the platform", async () => {
    calls.length = 0;
    const out = await roundtrip(server(), [
      rpc(1, "tools/call", { name: "meshpoint_recall", arguments: {} }),
      rpc(2, "tools/call", { name: "meshpoint_file_context", arguments: { path: path.join(dir, "src/a.ts") } }),
      rpc(3, "tools/call", { name: "meshpoint_items_put", arguments: { items: [{ kind: "gotcha", title: "T", body: "B", key: "slot" }] } }),
      rpc(4, "tools/call", { name: "meshpoint_items_retract", arguments: { ids: ["d1234567"] } }),
      rpc(5, "tools/call", { name: "meshpoint_items_confirm", arguments: { ids: ["d1234567"] } }),
    ]);
    // Answers go out as each tool finishes, so they are matched by id, not by position.
    const byId = new Map(out.map((o) => [o.id as number, o.result as { content: Array<{ text: string }>; isError: boolean }]));
    const text = (id: number) => byId.get(id)!.content[0]!.text;
    expect([...byId.values()].map((r) => r.isError && r.content[0]!.text)).toEqual([false, false, false, false, false]);
    expect(text(1)).toContain("# Meshpoint: p @ master");
    expect(text(1)).toContain("d1234567 [decision] Use KV: edge speed");
    expect(text(2)).toBe("Meshpoint, src/a.ts:\n- sam's codex edited this file just now on master.");
    expect(JSON.parse(text(3))).toEqual({ count: 1, superseded: 0, project: "p", branch: "master" });
    expect((calls.find((c) => c.url.endsWith("/v1/items") && c.method === "POST")?.body as { items: unknown[] }).items[0]).toMatchObject({ kind: "gotcha", title: "T", body: "B", key: "slot" });
    expect(JSON.parse(text(4))).toEqual({ retracted: ["d1234567-0000"] });
    expect(JSON.parse(text(5))).toEqual({ confirmed: ["d1234567-0000"] });
  });

  it("tool errors are results with isError, not protocol errors", async () => {
    const out = await roundtrip(server({ tap: false }), [rpc(1, "tools/call", { name: "meshpoint_recall" }), rpc(2, "tools/call", { name: "meshpoint_items_put", arguments: { items: [] } })]);
    expect(out[0]).toMatchObject({ result: { isError: true } });
    expect((out[0]!.result as { content: Array<{ text: string }> }).content[0]!.text).toContain("not inside a git repository");
    expect(out[1]).toMatchObject({ result: { isError: true } });
  });
});

describe("connect mcp", () => {
  it("adds and removes the entry in .mcp.json, keeping other servers", () => {
    expect(installMcpEntry({})).toEqual({ mcpServers: { meshpoint: MCP_ENTRY } });
    expect(removeMcpEntry({ mcpServers: { meshpoint: MCP_ENTRY, other: { command: "x" } }, extra: 1 })).toEqual({ mcpServers: { other: { command: "x" } }, extra: 1 });
    expect(removeMcpEntry({ mcpServers: { meshpoint: MCP_ENTRY } })).toEqual({});
    writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    expect(connectMcp({ remove: false, projectDir: dir })).toContain(".mcp.json");
    expect(JSON.parse(readFileSync(path.join(dir, ".mcp.json"), "utf8"))).toEqual({ mcpServers: { other: { command: "x" }, meshpoint: MCP_ENTRY } });
    connectMcp({ remove: true, projectDir: dir });
    expect(JSON.parse(readFileSync(path.join(dir, ".mcp.json"), "utf8"))).toEqual({ mcpServers: { other: { command: "x" } } });
    expect(connectMcp({ remove: false })).toContain("claude_desktop_config.json");
  });
});
