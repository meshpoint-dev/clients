// Reads user and assistant text, and the files touched through tools, out of an Antigravity
// transcript.jsonl. The hooks reference (antigravity.google/docs/hooks, "Common input fields")
// documents only the file's path, not its line schema, so this reader is tolerant: it accepts the
// Gemini content shape ({role: "user"|"model", parts: [{text}|{functionCall: {name, args}}]}) and
// the generic shape ({role|type, content: string|[{type: "text", text}]}). Tool arguments use the
// names from the hooks reference's tool list (TargetFile, AbsolutePath). Needs a live check.

import type { TranscriptEntry } from "../claude-code/transcript.js";

const PATH_KEYS = ["TargetFile", "AbsolutePath", "file_path", "path"] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function role(record: Record<string, unknown>): TranscriptEntry["role"] | null {
  const raw = record.role ?? record.type ?? record.author;
  if (typeof raw !== "string") return null;
  const r = raw.toLowerCase();
  if (r === "user" || r === "human") return "user";
  if (r === "assistant" || r === "model" || r === "agent") return "assistant";
  return null;
}

function timestamp(raw: unknown): number {
  if (typeof raw === "string") return Date.parse(raw) || 0;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
  return raw < 1e12 ? raw * 1000 : raw;
}

function pathsOf(args: unknown, out: string[]): void {
  if (!isRecord(args)) return;
  for (const key of PATH_KEYS) {
    const v = args[key];
    if (typeof v === "string" && v) out.push(v);
  }
}

function collect(block: unknown, texts: string[], paths: string[]): void {
  if (typeof block === "string") {
    texts.push(block);
    return;
  }
  if (!isRecord(block)) return;
  if (typeof block.text === "string") texts.push(block.text);
  if (isRecord(block.functionCall)) pathsOf(block.functionCall.args, paths);
  pathsOf(block.input, paths);
  if (isRecord(block.toolCall)) pathsOf(block.toolCall.args, paths);
}

export function parseAntigravityTranscript(jsonl: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    const message = isRecord(parsed.message) ? parsed.message : parsed;
    const r = role(parsed) ?? role(message);
    if (!r) continue;
    const texts: string[] = [];
    const paths: string[] = [];
    const body = message.parts ?? message.content ?? message.text;
    if (Array.isArray(body)) for (const block of body) collect(block, texts, paths);
    else collect(body, texts, paths);
    if (isRecord(parsed.toolCall)) pathsOf(parsed.toolCall.args, paths);
    const text = texts.join("\n").trim();
    // Tool results come back as user-role records with no prose; skip those so turns stay human.
    if (!text && (r === "user" || paths.length === 0)) continue;
    entries.push({ role: r, text, paths, at: timestamp(parsed.timestamp ?? parsed.createTime ?? message.timestamp) });
  }
  return entries;
}
