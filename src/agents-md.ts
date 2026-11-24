import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isExpired, type Item } from "@meshpoint/sdk";

// The team's conventions as a committed block in AGENTS.md, for agents that read that file but
// have no Meshpoint hook (and for teammates without Meshpoint at all). The block is the only
// part of the file the CLI touches; every line carries its item id so the session-start inject
// can leave out what the harness already read from the file.

export const AGENTS_FILE = "AGENTS.md";
export const BLOCK_START = "<!-- meshpoint:conventions start -->";
export const BLOCK_END = "<!-- meshpoint:conventions end -->";
const ID_TAG = /<!--\s*mp:([A-Za-z0-9_-]{8,})\s*-->/g;
const CLAUDE_IMPORT = /^@(?:\.\/)?AGENTS\.md\s*$/m;

// Harnesses that read AGENTS.md at the repository root on their own. Claude Code reads CLAUDE.md
// and follows an `@AGENTS.md` import line; the rest get no deduplication.
const AGENTS_MD_READERS: ReadonlySet<string> = new Set(["codex", "cursor", "pi", "opencode"]);

export function currentConventions(items: readonly Item[], now = Date.now()): Item[] {
  return items
    .filter((i) => i.kind === "convention" && !i.retracted && i.state !== "dropped" && i.state !== "superseded" && !isExpired(i, now))
    .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1));
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function sentence(s: string): string {
  const t = oneLine(s);
  return /[.!?:]$/.test(t) ? t : `${t}.`;
}

export function renderBlock(items: readonly Item[]): string {
  const lines = [BLOCK_START, "## Team conventions", "Kept by Meshpoint from the team's conventions. Refresh with `meshpoint export agents`; change the items in Meshpoint, not here.", ""];
  if (items.length === 0) lines.push("No conventions recorded yet.");
  for (const i of items) lines.push(`- ${sentence(i.title)} ${oneLine(i.body)} <!-- mp:${i.id} -->`);
  lines.push(BLOCK_END);
  return lines.join("\n");
}

// Replaces the block in place, appends it to a file without one, or starts a new file.
export function applyBlock(existing: string | null, block: string): string {
  if (existing === null) return `# Agent instructions\n\n${block}\n`;
  const start = existing.indexOf(BLOCK_START);
  const end = existing.indexOf(BLOCK_END, start);
  if (start >= 0 && end > start) return `${existing.slice(0, start)}${block}${existing.slice(end + BLOCK_END.length)}`;
  const head = existing.replace(/\s+$/, "");
  return `${head ? `${head}\n\n` : ""}${block}\n`;
}

export function blockIds(text: string): Set<string> {
  return new Set([...text.matchAll(ID_TAG)].map((m) => m[1] as string));
}

export interface ExportOptions {
  // Repo-relative target; AGENTS.md by default.
  file?: string;
  // Report whether the file would change; write nothing.
  check?: boolean;
  now?: number;
}

export interface ExportOutcome {
  file: string;
  created: boolean;
  changed: boolean;
  count: number;
}

export function exportConventions(items: readonly Item[], root: string, opts: ExportOptions = {}): ExportOutcome {
  const rel = opts.file ?? AGENTS_FILE;
  const abs = path.join(root, rel);
  const existing = read(abs);
  const conventions = currentConventions(items, opts.now);
  const next = applyBlock(existing, renderBlock(conventions));
  const changed = next !== existing;
  if (changed && !opts.check) writeFileSync(abs, next);
  return { file: rel, created: existing === null, changed, count: conventions.length };
}

export function hasBlock(root: string, file = AGENTS_FILE): boolean {
  const text = read(path.join(root, file));
  return text !== null && text.includes(BLOCK_START) && text.includes(BLOCK_END);
}

export interface CommittedConventions {
  // The file the harness reads, repo-relative.
  file: string;
  ids: Set<string>;
}

// Convention ids this harness already has in front of it from a committed file, or null.
export function committedConventions(root: string, harness: string): CommittedConventions | null {
  if (harness === "claude-code") {
    const claude = read(path.join(root, "CLAUDE.md"));
    if (!claude) return null;
    const ids = blockIds(claude);
    if (CLAUDE_IMPORT.test(claude)) for (const id of blockIds(read(path.join(root, AGENTS_FILE)) ?? "")) ids.add(id);
    return ids.size > 0 ? { file: "CLAUDE.md", ids } : null;
  }
  if (!AGENTS_MD_READERS.has(harness)) return null;
  const ids = blockIds(read(path.join(root, AGENTS_FILE)) ?? "");
  return ids.size > 0 ? { file: AGENTS_FILE, ids } : null;
}

function read(abs: string): string | null {
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}
