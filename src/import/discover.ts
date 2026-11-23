import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { projectIdFromRemote } from "@meshpoint/sdk";
import { parseAntigravityTranscript } from "../antigravity/transcript.js";
import { parseTranscript as parseClaudeCodeTranscript, type TranscriptEntry } from "../claude-code/transcript.js";
import { parseCodexTranscript } from "../codex/transcript.js";
import type { Environment } from "../config.js";
import { parseCursorTranscript } from "../cursor/transcript.js";
import type { Harness } from "../detect.js";

// Finds the session transcripts each harness keeps on this machine and reads them into one shape.
// Every reader is tolerant: a file that does not parse is skipped, never fatal. Nothing here talks
// to the network or writes anything.

export interface DiscoveredSession {
  harness: Harness;
  file: string;
  id: string;
  // Working directory the harness recorded; null when the store does not say.
  cwd: string | null;
  // Branch the harness recorded; null when unknown (then the project's default branch is used).
  branch: string | null;
  startedAt: number;
  endedAt: number;
  entries: TranscriptEntry[];
  // Project id derived from the cwd's origin remote; null when the directory is gone or not a repo.
  project: string | null;
  // Set when only the header was read: an unmapped session counted for the report, never distilled.
  skimmed?: true;
}

export interface DiscoverOptions {
  env?: Environment;
  home?: string;
  harnesses?: readonly Harness[];
  // Resolves a directory to a project id; the default asks git for the origin remote.
  projectOf?: (cwd: string) => string | null;
  // Files last written before this epoch ms are not read at all.
  since?: number;
  // Only this project's sessions are parsed in full; other projects are skipped and sessions
  // without a project are skimmed (header only).
  project?: string;
  // Extra directories that may own Antigravity chats, such as the current repository root.
  roots?: readonly string[];
}

// What to do with a transcript once its directory is known.
type Gate = "skip" | "skim" | "full";

interface Ctx {
  home: string;
  env: Environment;
  since: number;
  gate: (cwd: string | null) => Gate;
}

// The first records of a JSONL file, enough for the header fields, without reading the rest.
const HEAD_BYTES = 64 * 1024;

function headRecords(file: string): Record<string, unknown>[] {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    const lines = buf.subarray(0, n).toString("utf8").split("\n");
    if (n === HEAD_BYTES) lines.pop();
    const out: Record<string, unknown>[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const v = JSON.parse(line) as unknown;
        if (isRecord(v)) out.push(v);
      } catch {
        continue;
      }
    }
    return out;
  } finally {
    closeSync(fd);
  }
}

// Modification time, or null when the file predates the window.
function mtimeIn(file: string, since: number): number | null {
  const m = statSync(file).mtimeMs;
  return m < since ? null : m;
}

function skimmed(harness: Harness, file: string, id: string, cwd: string | null, branch: string | null, mtime: number): DiscoveredSession {
  return { harness, file, id, cwd, branch, startedAt: mtime, endedAt: mtime, entries: [], project: null, skimmed: true };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readJsonl(file: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as unknown;
      if (isRecord(v)) out.push(v);
    } catch {
      continue;
    }
  }
  return out;
}

function walk(dir: string, pick: (file: string) => boolean, depth = 6): string[] {
  if (depth < 0 || !existsSync(dir)) return [];
  const out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  for (const name of names) {
    const p = path.join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...walk(p, pick, depth - 1));
    else if (pick(p)) out.push(p);
  }
  return out;
}

function span(entries: readonly TranscriptEntry[], fallback: number): { startedAt: number; endedAt: number } {
  const times = entries.map((e) => e.at).filter((t) => t > 0);
  return { startedAt: times.length ? Math.min(...times) : fallback, endedAt: times.length ? Math.max(...times) : fallback };
}

// The default project resolver: git's origin remote for the recorded directory, cached per directory.
export function gitProjectResolver(): (cwd: string) => string | null {
  const cache = new Map<string, string | null>();
  return (cwd) => {
    if (cache.has(cwd)) return cache.get(cwd) ?? null;
    let id: string | null = null;
    if (existsSync(cwd)) {
      try {
        const remote = execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], { stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).toString().trim();
        id = remote ? projectIdFromRemote(remote) : null;
      } catch {
        id = null;
      }
    }
    cache.set(cwd, id);
    return id;
  };
}

// --- readers -----------------------------------------------------------------------------------

function claudeCode(ctx: Ctx): DiscoveredSession[] {
  const root = ctx.env.CLAUDE_CONFIG_DIR || path.join(ctx.home, ".claude");
  const out: DiscoveredSession[] = [];
  for (const file of walk(path.join(root, "projects"), (f) => f.endsWith(".jsonl"), 2)) {
    try {
      const mtime = mtimeIn(file, ctx.since);
      if (mtime === null) continue;
      let cwd: string | null = null;
      let branch: string | null = null;
      let id = path.basename(file, ".jsonl");
      for (const r of headRecords(file)) {
        if (typeof r.cwd === "string" && !cwd) cwd = r.cwd;
        if (typeof r.gitBranch === "string" && !branch) branch = r.gitBranch;
        if (typeof r.sessionId === "string") id = r.sessionId;
        if (cwd && branch) break;
      }
      const gate = ctx.gate(cwd);
      if (gate === "skip") continue;
      if (gate === "skim") {
        out.push(skimmed("claude-code", file, id, cwd, branch, mtime));
        continue;
      }
      const entries = parseClaudeCodeTranscript(readFileSync(file, "utf8"));
      if (entries.length === 0) continue;
      out.push({ harness: "claude-code", file, id, cwd, branch, ...span(entries, mtime), entries, project: null });
    } catch {
      continue;
    }
  }
  return out;
}

function codex(ctx: Ctx): DiscoveredSession[] {
  const root = ctx.env.CODEX_HOME || path.join(ctx.home, ".codex");
  const out: DiscoveredSession[] = [];
  for (const file of walk(path.join(root, "sessions"), (f) => path.basename(f).startsWith("rollout-") && f.endsWith(".jsonl"), 4)) {
    try {
      const mtime = mtimeIn(file, ctx.since);
      if (mtime === null) continue;
      const meta = headRecords(file).find((r) => r.type === "session_meta");
      const payload = isRecord(meta?.payload) ? meta.payload : {};
      const git = isRecord(payload.git) ? payload.git : {};
      const id = typeof payload.id === "string" ? payload.id : path.basename(file, ".jsonl");
      const cwd = typeof payload.cwd === "string" ? payload.cwd : null;
      const branch = typeof git.branch === "string" ? git.branch : null;
      const gate = ctx.gate(cwd);
      if (gate === "skip") continue;
      if (gate === "skim") {
        out.push(skimmed("codex", file, id, cwd, branch, mtime));
        continue;
      }
      const entries = parseCodexTranscript(readFileSync(file, "utf8"));
      if (entries.length === 0) continue;
      out.push({ harness: "codex", file, id, cwd, branch, ...span(entries, mtime), entries, project: null });
    } catch {
      continue;
    }
  }
  return out;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (isRecord(c) && c.type === "text" && typeof c.text === "string" ? c.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function pi(ctx: Ctx): DiscoveredSession[] {
  const root = ctx.env.PI_CODING_AGENT_DIR || path.join(ctx.home, ".pi", "agent");
  const out: DiscoveredSession[] = [];
  for (const file of walk(path.join(root, "sessions"), (f) => f.endsWith(".jsonl"), 2)) {
    try {
      const mtime = mtimeIn(file, ctx.since);
      if (mtime === null) continue;
      const head = headRecords(file).find((r) => r.type === "session");
      const id = typeof head?.id === "string" ? head.id : path.basename(file, ".jsonl");
      const cwd = typeof head?.cwd === "string" ? head.cwd : null;
      const gate = ctx.gate(cwd);
      if (gate === "skip") continue;
      if (gate === "skim") {
        out.push(skimmed("pi", file, id, cwd, null, mtime));
        continue;
      }
      const records = readJsonl(file);
      const entries: TranscriptEntry[] = [];
      for (const r of records) {
        if (r.type !== "message" || !isRecord(r.message)) continue;
        const role = r.message.role;
        if (role !== "user" && role !== "assistant") continue;
        const text = textOf(r.message.content);
        if (!text) continue;
        entries.push({ role, text, paths: [], at: typeof r.timestamp === "string" ? Date.parse(r.timestamp) || 0 : 0 });
      }
      if (entries.length === 0) continue;
      out.push({ harness: "pi", file, id, cwd, branch: null, ...span(entries, mtime), entries, project: null });
    } catch {
      continue;
    }
  }
  return out;
}

function opencode(ctx: Ctx): DiscoveredSession[] {
  const root = path.join(ctx.env.XDG_DATA_HOME || path.join(ctx.home, ".local", "share"), "opencode", "storage");
  const out: DiscoveredSession[] = [];
  for (const file of walk(path.join(root, "session"), (f) => f.endsWith(".json"), 2)) {
    try {
      const mtime = mtimeIn(file, ctx.since);
      if (mtime === null) continue;
      const s = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      if (typeof s.id !== "string") continue;
      const cwd = typeof s.directory === "string" ? s.directory : null;
      const gate = ctx.gate(cwd);
      if (gate === "skip") continue;
      if (gate === "skim") {
        out.push(skimmed("opencode", file, s.id, cwd, null, mtime));
        continue;
      }
      const msgDir = path.join(root, "message", s.id);
      const messages = walk(msgDir, (f) => f.endsWith(".json"), 0)
        .map((f) => JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown>)
        .filter((m) => m.role === "user" || m.role === "assistant")
        .sort((a, b) => Number((a.time as Record<string, unknown> | undefined)?.created ?? 0) - Number((b.time as Record<string, unknown> | undefined)?.created ?? 0));
      const entries: TranscriptEntry[] = [];
      for (const m of messages) {
        const parts = walk(path.join(root, "part", String(m.id)), (f) => f.endsWith(".json"), 0)
          .map((f) => JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown>)
          .filter((p) => p.type === "text" && typeof p.text === "string" && !p.synthetic)
          .map((p) => String(p.text).trim())
          .filter(Boolean);
        if (parts.length === 0) continue;
        entries.push({ role: m.role as "user" | "assistant", text: parts.join("\n"), paths: [], at: Number((m.time as Record<string, unknown> | undefined)?.created ?? 0) });
      }
      if (entries.length === 0) continue;
      const time = isRecord(s.time) ? s.time : {};
      out.push({
        harness: "opencode",
        file,
        id: s.id,
        cwd,
        branch: null,
        startedAt: Number(time.created ?? 0) || span(entries, mtime).startedAt,
        endedAt: Number(time.updated ?? 0) || span(entries, mtime).endedAt,
        entries,
        project: null,
      });
    } catch {
      continue;
    }
  }
  return out;
}

// Antigravity keeps chats under a sha256 of the project directory; the directory itself is not
// stored. Candidate directories are the cwds other harnesses recorded plus the user's code roots.
function antigravity(ctx: Ctx, candidates: Iterable<string>): DiscoveredSession[] {
  const root = ctx.env.GEMINI_CLI_HOME || path.join(ctx.home, ".gemini");
  const byHash = new Map<string, string>();
  for (const dir of candidates) byHash.set(createHash("sha256").update(dir).digest("hex"), dir);
  const out: DiscoveredSession[] = [];
  for (const file of walk(path.join(root, "tmp"), (f) => f.endsWith(".json") && path.basename(path.dirname(f)) === "chats", 3)) {
    try {
      const mtime = mtimeIn(file, ctx.since);
      if (mtime === null) continue;
      // The directory hash is the folder name; the chat file may repeat it.
      const dirHash = path.basename(path.dirname(path.dirname(file)));
      const gate = ctx.gate(byHash.get(dirHash) ?? null);
      if (gate === "skip") continue;
      if (gate === "skim") {
        out.push(skimmed("antigravity", file, path.basename(file, ".json"), byHash.get(dirHash) ?? null, null, mtime));
        continue;
      }
      const s = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      const messages = Array.isArray(s.messages) ? s.messages : [];
      const jsonl = messages
        .filter((m): m is Record<string, unknown> => isRecord(m) && (m.type === "user" || m.type === "gemini"))
        .map((m) => JSON.stringify({ role: m.type === "user" ? "user" : "model", content: typeof m.content === "string" ? m.content : textOf(m.content), timestamp: m.timestamp }))
        .join("\n");
      const entries = parseAntigravityTranscript(jsonl);
      if (entries.length === 0) continue;
      const hash = typeof s.projectHash === "string" ? s.projectHash : path.basename(path.dirname(path.dirname(file)));
      out.push({
        harness: "antigravity",
        file,
        id: typeof s.sessionId === "string" ? s.sessionId : path.basename(file, ".json"),
        cwd: byHash.get(hash) ?? null,
        branch: null,
        startedAt: typeof s.startTime === "string" ? Date.parse(s.startTime) || 0 : 0,
        endedAt: typeof s.lastUpdated === "string" ? Date.parse(s.lastUpdated) || 0 : 0,
        entries,
        project: null,
      });
    } catch {
      continue;
    }
  }
  return out;
}

// Cursor documents no transcript store; anything that looks like one under ~/.cursor is tried.
function cursor(ctx: Ctx): DiscoveredSession[] {
  const root = path.join(ctx.home, ".cursor");
  const out: DiscoveredSession[] = [];
  for (const file of walk(root, (f) => /transcript/i.test(f) && (f.endsWith(".jsonl") || f.endsWith(".json")), 5)) {
    try {
      const mtime = mtimeIn(file, ctx.since);
      if (mtime === null) continue;
      const id = path.basename(file).replace(/\.jsonl?$/, "");
      const gate = ctx.gate(null);
      if (gate === "skip") continue;
      if (gate === "skim") {
        out.push(skimmed("cursor", file, id, null, null, mtime));
        continue;
      }
      const entries = parseCursorTranscript(readFileSync(file, "utf8"));
      if (entries.length === 0) continue;
      out.push({ harness: "cursor", file, id, cwd: null, branch: null, ...span(entries, mtime), entries, project: null });
    } catch {
      continue;
    }
  }
  return out;
}

export const ALL_HARNESSES: readonly Harness[] = ["claude-code", "codex", "pi", "opencode", "antigravity", "cursor", "openclaw"];

export function discoverSessions(opts: DiscoverOptions = {}): DiscoveredSession[] {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const wanted = new Set(opts.harnesses ?? ALL_HARNESSES);
  const projectOf = opts.projectOf ?? gitProjectResolver();
  // Every directory seen in a header, including skipped sessions, helps map Antigravity chats.
  const seen = new Set<string>();
  const gate = (cwd: string | null): Gate => {
    if (cwd) seen.add(cwd);
    if (!opts.project) return "full";
    const project = cwd ? projectOf(cwd) : null;
    if (project === opts.project) return "full";
    return project === null ? "skim" : "skip";
  };
  const ctx: Ctx = { home, env, since: opts.since ?? 0, gate };
  const sessions: DiscoveredSession[] = [];
  if (wanted.has("claude-code")) sessions.push(...claudeCode(ctx));
  if (wanted.has("codex")) sessions.push(...codex(ctx));
  if (wanted.has("pi")) sessions.push(...pi(ctx));
  if (wanted.has("opencode")) sessions.push(...opencode(ctx));
  if (wanted.has("cursor")) sessions.push(...cursor(ctx));
  if (wanted.has("antigravity")) {
    const candidates = new Set<string>([...seen, ...(opts.roots ?? [])]);
    for (const rootName of ["Code", "code", "src", "projects", "work", "dev"]) {
      const root = path.join(home, rootName);
      if (!existsSync(root)) continue;
      try {
        for (const name of readdirSync(root)) candidates.add(path.join(root, name));
      } catch {
        // unreadable root
      }
    }
    sessions.push(...antigravity(ctx, candidates));
  }
  // OpenClaw keeps no transcript on disk that hooks or this reader can see.
  for (const s of sessions) s.project = s.cwd ? projectOf(s.cwd) : null;
  return sessions.sort((a, b) => b.endedAt - a.endedAt);
}
