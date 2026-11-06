// Reads what matters out of a Claude Code transcript (JSONL): user and assistant text, and the
// files the assistant touched through tools. Pure functions over the file contents.

export interface TranscriptEntry {
  role: "user" | "assistant";
  text: string;
  paths: string[];
  // Epoch ms from the record's timestamp; 0 when absent.
  at: number;
}

const PATH_KEYS = ["file_path", "path", "notebook_path"] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseTranscript(jsonl: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || (parsed.type !== "user" && parsed.type !== "assistant")) continue;
    const message = isRecord(parsed.message) ? parsed.message : undefined;
    const content = message?.content;
    const texts: string[] = [];
    const paths: string[] = [];
    if (typeof content === "string") texts.push(content);
    else if (Array.isArray(content)) {
      for (const block of content) {
        if (!isRecord(block)) continue;
        if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
        if (block.type === "tool_use" && isRecord(block.input)) {
          for (const key of PATH_KEYS) {
            const v = block.input[key];
            if (typeof v === "string" && v) paths.push(v);
          }
        }
      }
    }
    const text = texts.join("\n").trim();
    if (!text && paths.length === 0) continue;
    // Tool results arrive as "user" records with no prose; skip those so turns stay human.
    if (parsed.type === "user" && !text) continue;
    const at = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) || 0 : 0;
    entries.push({ role: parsed.type, text, paths, at });
  }
  return entries;
}

// The assistant's whole reply to the latest prompt: every assistant record after the last user
// record, text joined, touched paths deduplicated in order.
export function lastAssistantTurn(entries: TranscriptEntry[]): { text: string; paths: string[] } | null {
  let start = entries.length;
  while (start > 0 && entries[start - 1]?.role === "assistant") start -= 1;
  const reply = entries.slice(start);
  if (reply.length === 0) return null;
  const texts = reply.map((e) => e.text).filter(Boolean);
  const paths = [...new Set(reply.flatMap((e) => e.paths))];
  if (texts.length === 0 && paths.length === 0) return null;
  return { text: texts.join("\n\n"), paths };
}

export function lastUserText(entries: TranscriptEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i];
    if (e?.role === "user" && e.text) return e.text;
  }
  return null;
}
