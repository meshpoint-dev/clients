// Cursor documents transcript_path only as "path to the main conversation transcript file"
// (https://cursor.com/docs/hooks, "Common schema"); the file format is undocumented. Try the two
// shapes Cursor itself reads for compatibility, Claude Code's and Codex's, then flat
// {role, content | text} records, as JSONL or one JSON array.

import { parseTranscript as parseClaudeCodeTranscript, type TranscriptEntry } from "../claude-code/transcript.js";
import { parseCodexTranscript } from "../codex/transcript.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function records(raw: string): unknown[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Not one JSON document; read it as JSONL below.
    }
  }
  const out: unknown[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return out;
}

function textOf(v: unknown): string {
  if (typeof v === "string") return v;
  if (!Array.isArray(v)) return "";
  return v
    .map((b) => (typeof b === "string" ? b : isRecord(b) && typeof b.text === "string" ? b.text : ""))
    .filter(Boolean)
    .join("\n");
}

function epochMs(v: unknown): number {
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string") return Date.parse(v) || 0;
  return 0;
}

function parseGenericTranscript(raw: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const r of records(raw)) {
    if (!isRecord(r)) continue;
    const role = r.role ?? r.type;
    if (role !== "user" && role !== "assistant") continue;
    const text = textOf(r.content ?? r.text).trim();
    if (!text) continue;
    entries.push({ role, text, paths: [], at: epochMs(r.timestamp ?? r.createdAt ?? r.created_at) });
  }
  return entries;
}

export function parseCursorTranscript(raw: string): TranscriptEntry[] {
  for (const parse of [parseClaudeCodeTranscript, parseCodexTranscript, parseGenericTranscript]) {
    const entries = parse(raw);
    if (entries.length > 0) return entries;
  }
  return [];
}
