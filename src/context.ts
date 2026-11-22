import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Item, Presence } from "@meshpoint/sdk";
import type { Verdict } from "./verify.js";

// Per-session state for the edit hook: the branch's items as seen at session start (with the
// local verdicts) and the files already noticed, so one file gets one notice per session.
export const EDIT_ITEMS_MAX = 2;
export const EDIT_KINDS: ReadonlySet<string> = new Set(["gotcha", "decision", "convention"]);

export interface CachedRecall {
  project: string;
  branch: string;
  items: Item[];
  verdicts: Record<string, Verdict>;
  at: number;
}

function safe(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_");
}

export class SessionCache {
  constructor(private readonly dir: string) {}

  private recallFile(session: string): string {
    return path.join(this.dir, "recall", `${safe(session)}.json`);
  }

  private editsFile(session: string): string {
    return path.join(this.dir, "edits", `${safe(session)}.json`);
  }

  private write(file: string, value: unknown): void {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  }

  saveRecall(session: string, cached: CachedRecall): void {
    this.write(this.recallFile(session), cached);
  }

  loadRecall(session: string): CachedRecall | null {
    try {
      const parsed = JSON.parse(readFileSync(this.recallFile(session), "utf8")) as CachedRecall;
      return Array.isArray(parsed.items) ? parsed : null;
    } catch {
      return null;
    }
  }

  // True the first time a file is seen in the session; false afterwards.
  firstEdit(session: string, filePath: string): boolean {
    const file = this.editsFile(session);
    let seen: string[] = [];
    try {
      seen = JSON.parse(readFileSync(file, "utf8")) as string[];
    } catch {
      seen = [];
    }
    if (seen.includes(filePath)) return false;
    this.write(file, [...seen, filePath]);
    return true;
  }

  forget(session: string): void {
    rmSync(this.recallFile(session), { force: true });
    rmSync(this.editsFile(session), { force: true });
  }

  // The import nudge shows once per project branch on this machine. True the first time.
  firstImportNudge(project: string, branch: string): boolean {
    const file = path.join(this.dir, "import", `${safe(`${project}--${branch}`)}`);
    try {
      readFileSync(file);
      return false;
    } catch {
      this.write(file, { at: Date.now() });
      return true;
    }
  }
}

// Items worth showing when a file is edited: those naming it, of the kinds that bite, not dropped
// locally stale, ranked the way recall ranks them (kind weight, then recency, then confirmations).
const KIND_WEIGHT: Record<string, number> = { decision: 5, gotcha: 4, convention: 3, fact: 2, status: 2, todo: 1 };

export function itemsForFile(items: readonly Item[], verdicts: Readonly<Record<string, Verdict>>, filePath: string): Item[] {
  return items
    .filter((i) => !i.retracted && i.state !== "dropped" && EDIT_KINDS.has(i.kind) && verdicts[i.id] !== "stale")
    .filter((i) => i.refs.includes(filePath) || i.paths.includes(filePath))
    .sort((a, b) => (KIND_WEIGHT[b.kind] ?? 0) - (KIND_WEIGHT[a.kind] ?? 0) || b.created_at - a.created_at || b.confirmations - a.confirmations)
    .slice(0, EDIT_ITEMS_MAX);
}

function age(ms: number): string {
  const m = Math.floor(ms / 60_000);
  return m < 1 ? "just now" : `${m}m ago`;
}

// The notice injected around an edit, or "" when there is nothing to say.
export function renderEditNotice(filePath: string, items: readonly Item[], presence: readonly Presence[], now: number): string {
  if (items.length === 0 && presence.length === 0) return "";
  const lines = [`Meshpoint, ${filePath}:`];
  for (const p of presence) lines.push(`- ${p.user}'s ${p.agent} edited this file ${age(now - p.updated_at)} on ${p.branch}.`);
  for (const i of items) lines.push(`- [${i.kind}] ${i.title}: ${i.body}`);
  return lines.join("\n");
}

// Committed instruction files that can seed a branch with no memory yet. Only tracked files
// count, so a stray local note never triggers the import nudge.
export const INSTRUCTION_FILE_PATTERNS = [
  "CLAUDE.md",
  "AGENTS.md",
  "GEMINI.md",
  ".cursorrules",
  ".claude/CLAUDE.md",
  ".claude/rules/*.md",
  ".cursor/rules/*",
  ".codex/AGENTS.md",
  ".github/copilot-instructions.md",
  ".kiro/steering/*.md",
  ".junie/guidelines.md",
];

export function instructionFiles(git: (args: string[]) => string | null): string[] {
  const out = git(["ls-files", "--", ...INSTRUCTION_FILE_PATTERNS]);
  if (!out) return [];
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 20);
}

export function renderImportNudge(files: readonly string[]): string {
  return [
    "This branch has no team knowledge yet.",
    `Instruction files found: ${files.join(", ")}.`,
    "Run the meshpoint-import skill once to seed items from them, then continue.",
  ].join("\n");
}
