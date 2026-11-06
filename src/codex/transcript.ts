// Reads user and assistant text, and the files touched through apply_patch, out of a Codex CLI
// rollout (JSONL). Same TranscriptEntry shape as the Claude Code reader so the tap is shared.

import type { TranscriptEntry } from "../claude-code/transcript.js";

const INJECTED_USER_PREFIXES = ["# AGENTS.md instructions", "<environment_context>", "<permissions instructions>", "<user_instructions>"];
const PATCH_PATH_RE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function patchPaths(args: unknown): string[] {
  if (typeof args !== "string") return [];
  let input: unknown;
  try {
    input = JSON.parse(args);
  } catch {
    return [];
  }
  const patch = isRecord(input) ? (input.patch ?? input.input) : undefined;
  if (typeof patch !== "string") return [];
  return [...patch.matchAll(PATCH_PATH_RE)].map((m) => (m[1] as string).trim()).filter(Boolean);
}

export function parseCodexTranscript(jsonl: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || parsed.type !== "response_item" || !isRecord(parsed.payload)) continue;
    const payload = parsed.payload;
    const at = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) || 0 : 0;
    if (payload.type === "function_call" && payload.name === "apply_patch") {
      const paths = patchPaths(payload.arguments);
      if (paths.length) entries.push({ role: "assistant", text: "", paths, at });
      continue;
    }
    if (payload.type !== "message" || (payload.role !== "user" && payload.role !== "assistant") || !Array.isArray(payload.content)) continue;
    const text = payload.content
      .filter((b): b is { type: string; text: string } => isRecord(b) && (b.type === "input_text" || b.type === "output_text") && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (!text) continue;
    if (payload.role === "user" && INJECTED_USER_PREFIXES.some((p) => text.startsWith(p))) continue;
    entries.push({ role: payload.role, text, paths: [], at });
  }
  return entries;
}
