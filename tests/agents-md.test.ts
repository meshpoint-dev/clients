import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Item } from "@meshpoint/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyBlock, BLOCK_END, BLOCK_START, blockIds, committedConventions, CONTEXT_END, CONTEXT_START, currentConventions, exportConventions, hasBlock, renderBlock, writeContext } from "../src/agents-md.js";
import { renderInject } from "../src/tap.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "mp-agents-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function item(id: string, over: Partial<Item> = {}): Item {
  return { id, branch: "master", kind: "convention", title: `Rule ${id}`, body: `Body ${id}`, created_at: 1, confirmations: 0, retracted: 0, provenance: "", refs: [], paths: [], commit_sha: "", state: "ok", verified_at: 0, stale_count: 0, key: "", superseded_by: "", confirmed_at: 0, ...over };
}

const items = [item("b2345678", { created_at: 2 }), item("a1234567", { created_at: 1 }), item("gotcha-1", { kind: "gotcha" }), item("retracted", { retracted: 1 }), item("superseded", { state: "superseded" }), item("dropped", { state: "dropped" })];

describe("conventions block", () => {
  it("keeps live conventions only, oldest first", () => {
    expect(currentConventions(items, 10).map((i) => i.id)).toEqual(["a1234567", "b2345678"]);
  });

  it("renders one line per convention with its id, titles ending in a period, bodies on one line", () => {
    const block = renderBlock([item("a1234567", { title: "Use rg", body: "Not grep.\nEver." })]);
    expect(block.startsWith(BLOCK_START)).toBe(true);
    expect(block.endsWith(BLOCK_END)).toBe(true);
    expect(block).toContain("- Use rg. Not grep. Ever. <!-- mp:a1234567 -->");
    expect(renderBlock([])).toContain("No conventions recorded yet.");
  });

  it("starts a file, appends to one without a block, replaces the block in place", () => {
    const block = renderBlock([item("a1234567")]);
    expect(applyBlock(null, block)).toBe(`# Agent instructions\n\n${block}\n`);
    expect(applyBlock("# Ours\n\nKeep this.\n\n", block)).toBe(`# Ours\n\nKeep this.\n\n${block}\n`);
    const replaced = applyBlock(`# Ours\n\n${BLOCK_START}\nold\n${BLOCK_END}\n\n## After\n`, block);
    expect(replaced).toBe(`# Ours\n\n${block}\n\n## After\n`);
    expect(replaced).not.toContain("old");
  });

  it("writes AGENTS.md, reports no change on a rerun, and --check never writes", () => {
    const first = exportConventions(items, root, { now: 10 });
    expect(first).toEqual({ file: "AGENTS.md", created: true, changed: true, count: 2 });
    expect(hasBlock(root)).toBe(true);
    expect(blockIds(readFileSync(path.join(root, "AGENTS.md"), "utf8"))).toEqual(new Set(["a1234567", "b2345678"]));
    expect(exportConventions(items, root, { now: 10 })).toMatchObject({ created: false, changed: false });
    const more = [...items, item("c3456789", { created_at: 3 })];
    expect(exportConventions(more, root, { now: 10, check: true })).toMatchObject({ changed: true, count: 3 });
    expect(blockIds(readFileSync(path.join(root, "AGENTS.md"), "utf8")).size).toBe(2);
  });

  it("writes the context block beside the conventions block and replaces it on rerun", () => {
    exportConventions(items, root, { now: 10 });
    const first = writeContext("# Meshpoint: p @ master\n\n## Team knowledge (1)\n- a1 [decision] X: y", root);
    expect(first).toEqual({ file: "AGENTS.md", created: false, changed: true });
    let text = readFileSync(path.join(root, "AGENTS.md"), "utf8");
    expect(text).toContain(`${CONTEXT_START}\n# Meshpoint: p @ master`);
    expect(text).toContain(CONTEXT_END);
    expect(blockIds(text)).toEqual(new Set(["a1234567", "b2345678"]));
    expect(writeContext("# Meshpoint: p @ master\n\n## Team knowledge (1)\n- a1 [decision] X: y", root).changed).toBe(false);
    writeContext("", root);
    text = readFileSync(path.join(root, "AGENTS.md"), "utf8");
    expect(text).toContain("No team knowledge for this branch yet.");
    expect(text.match(/meshpoint:context start/g)).toHaveLength(1);
    expect(text).toContain(BLOCK_START);
  });

  it("targets another file inside the repository", () => {
    exportConventions(items, root, { now: 10, file: "CLAUDE.md" });
    expect(hasBlock(root, "CLAUDE.md")).toBe(true);
    expect(hasBlock(root)).toBe(false);
  });
});

describe("committed conventions per harness", () => {
  it("AGENTS.md readers get its ids; Claude Code only through CLAUDE.md or its @AGENTS.md import; others nothing", () => {
    exportConventions(items, root, { now: 10 });
    expect(committedConventions(root, "codex")).toEqual({ file: "AGENTS.md", ids: new Set(["a1234567", "b2345678"]) });
    expect(committedConventions(root, "pi")?.ids.size).toBe(2);
    expect(committedConventions(root, "claude-code")).toBeNull();
    expect(committedConventions(root, "antigravity")).toBeNull();
    writeFileSync(path.join(root, "CLAUDE.md"), "# Project\n\n@AGENTS.md\n");
    expect(committedConventions(root, "claude-code")).toEqual({ file: "CLAUDE.md", ids: new Set(["a1234567", "b2345678"]) });
    writeFileSync(path.join(root, "CLAUDE.md"), `# Project\n\n${renderBlock([item("zz999999")])}\n`);
    expect(committedConventions(root, "claude-code")?.ids).toEqual(new Set(["zz999999"]));
  });

  it("the inject leaves out conventions the file already holds and says so", () => {
    const recall = { project: "p", branch: "master", checkpoint: null, items: [item("a1234567"), item("b2345678"), item("d1", { kind: "decision" as const })], generated_at: 0, source: "kv" as const };
    const repo = { project: "p", branch: "master", root };
    const text = renderInject(repo, recall, [], 10, new Map(), { file: "AGENTS.md", ids: new Set(["a1234567"]) });
    expect(text).toContain("## Team knowledge (2; first column is the item id; 1 convention is in AGENTS.md)");
    expect(text).not.toContain("a1234567");
    expect(text).toContain("b2345678");
    const only = renderInject(repo, { ...recall, items: [item("a1234567")] }, [], 10, new Map(), { file: "AGENTS.md", ids: new Set(["a1234567"]) });
    expect(only).toContain("## Team knowledge (1 convention is in AGENTS.md)");
    expect(renderInject(repo, recall, [], 10)).toContain("a1234567");
  });
});
