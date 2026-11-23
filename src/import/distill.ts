import { KINDS, redact, type Kind } from "@meshpoint/sdk";
import type { TranscriptEntry } from "../claude-code/transcript.js";
import { extractRefs } from "../refs.js";
import type { DiscoveredSession } from "./discover.js";
import { jsonBlock, type Runner } from "./runner.js";

// Turning transcripts into items with the user's own model: one call per session with the
// checkpoint skill's rules, then one call per branch that merges what the sessions proposed.

export interface ProposedItem {
  kind: Kind;
  title: string;
  body: string;
  key?: string;
  recurring?: boolean;
  sessions: string[];
}

// Transcript text kept per call: the start sets the task, the end holds what was established.
export const HEAD_CHARS = 20_000;
export const TAIL_CHARS = 40_000;
export const SESSION_ITEMS_MAX = 20;
export const BRANCH_ITEMS_MAX = 60;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

const RULES = `Write what a teammate's agent would need to resume work in this repository correctly, as items.
Each item is {"kind", "title", "body"}. kind is one of: decision (a choice made and why), gotcha (something that bit or will bite), convention (how things are done here), fact (a stable truth about the code or environment), status (where the work stands), todo (an agreed next step).
title is one line. body is one to three sentences, concrete: file names by repo-relative path, commands, values, reasons.
Rules: only what this session established, never invent; prefer durable knowledge over moment-to-moment detail; at most one status; no secrets, tokens or credentials; skip chit-chat and anything true of every project.`;

export function renderTranscript(entries: readonly TranscriptEntry[]): string {
  const lines = entries.map((e) => `[${e.role}] ${e.text}${e.paths.length ? `\n(files: ${e.paths.slice(0, 8).join(", ")})` : ""}`);
  const text = lines.join("\n\n");
  if (text.length <= HEAD_CHARS + TAIL_CHARS) return text;
  return `${text.slice(0, HEAD_CHARS)}\n\n[... ${text.length - HEAD_CHARS - TAIL_CHARS} characters omitted ...]\n\n${text.slice(-TAIL_CHARS)}`;
}

export function sessionPrompt(s: DiscoveredSession): string {
  return [
    RULES,
    "",
    `Harness: ${s.harness}. Repository directory: ${s.cwd ?? "unknown"}. Branch: ${s.branch ?? "unknown"}. Session started ${new Date(s.startedAt).toISOString()}.`,
    "",
    `Output only a JSON array of at most ${SESSION_ITEMS_MAX} items. Output [] if the session established nothing worth keeping.`,
    "",
    "Transcript:",
    renderTranscript(s.entries),
  ].join("\n");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseProposed(raw: string, session: string): ProposedItem[] {
  let parsed: unknown;
  try {
    parsed = jsonBlock(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: ProposedItem[] = [];
  for (const v of parsed) {
    if (!isRecord(v) || typeof v.kind !== "string" || !(KINDS as readonly string[]).includes(v.kind)) continue;
    if (typeof v.title !== "string" || !v.title.trim() || typeof v.body !== "string" || !v.body.trim()) continue;
    const item: ProposedItem = { kind: v.kind as Kind, title: redact(v.title.trim().slice(0, 200)), body: redact(v.body.trim().slice(0, 2000)), sessions: [session] };
    if (typeof v.key === "string" && KEY_RE.test(v.key)) item.key = v.key;
    if (v.recurring === true) item.recurring = true;
    out.push(item);
    if (out.length >= SESSION_ITEMS_MAX) break;
  }
  return out;
}

export async function distillSession(runner: Runner, s: DiscoveredSession): Promise<ProposedItem[]> {
  return parseProposed(await runner.run(sessionPrompt(s)), s.id);
}

export function consolidatePrompt(items: readonly ProposedItem[], live: readonly { id: string; kind: string; title: string; body: string }[]): string {
  return [
    "You merge knowledge items proposed from several coding sessions on one repository branch into one list.",
    "Input items carry the ids of the sessions that produced them. Rules:",
    "- Merge duplicates and near-duplicates into one item; keep every session id in \"sessions\".",
    "- When a fact or decision changed across sessions, keep only the newest statement (later session ids are newer in the list).",
    "- Give conventions a short stable \"key\" (letters, digits, . _ : / -) such as test-runner or deploy-target.",
    "- Mark a gotcha \"recurring\": true when the same problem appears in two or more sessions.",
    "- Drop status items and todos that read as finished; keep at most one status.",
    "- Items already live on the branch are listed; do not repeat them, and when a proposed item supersedes a live one, add \"supersedes\": [\"<live id>\"].",
    `- Output only a JSON array of at most ${BRANCH_ITEMS_MAX} items: {"kind","title","body","key"?,"recurring"?,"supersedes"?,"sessions"}.`,
    "",
    `Live items on the branch:\n${JSON.stringify(live.map((i) => ({ id: i.id, kind: i.kind, title: i.title, body: i.body })))}`,
    "",
    `Proposed items:\n${JSON.stringify(items)}`,
  ].join("\n");
}

export interface MergedItem extends ProposedItem {
  supersedes?: string[];
}

export function parseMerged(raw: string, fallback: readonly ProposedItem[]): MergedItem[] {
  let parsed: unknown;
  try {
    parsed = jsonBlock(raw);
  } catch {
    return [...fallback];
  }
  if (!Array.isArray(parsed)) return [...fallback];
  const out: MergedItem[] = [];
  for (const v of parsed) {
    if (!isRecord(v) || typeof v.kind !== "string" || !(KINDS as readonly string[]).includes(v.kind)) continue;
    if (typeof v.title !== "string" || !v.title.trim() || typeof v.body !== "string" || !v.body.trim()) continue;
    const item: MergedItem = {
      kind: v.kind as Kind,
      title: redact(v.title.trim().slice(0, 200)),
      body: redact(v.body.trim().slice(0, 2000)),
      sessions: Array.isArray(v.sessions) ? v.sessions.filter((x): x is string => typeof x === "string").slice(0, 50) : [],
    };
    if (typeof v.key === "string" && KEY_RE.test(v.key)) item.key = v.key;
    if (v.recurring === true) item.recurring = true;
    if (Array.isArray(v.supersedes)) item.supersedes = v.supersedes.filter((x): x is string => typeof x === "string").slice(0, 20);
    out.push(item);
    if (out.length >= BRANCH_ITEMS_MAX) break;
  }
  return out;
}

export async function consolidate(runner: Runner, items: readonly ProposedItem[], live: readonly { id: string; kind: string; title: string; body: string }[]): Promise<MergedItem[]> {
  if (items.length === 0) return [];
  return parseMerged(await runner.run(consolidatePrompt(items, live)), items);
}

// Items that name a file the checkout no longer has are left out of the proposal.
export function prune(items: readonly MergedItem[], root: string, exists?: (abs: string) => boolean): { kept: Array<MergedItem & { refs: string[] }>; dropped: Array<MergedItem & { missing: string[] }> } {
  const kept: Array<MergedItem & { refs: string[] }> = [];
  const dropped: Array<MergedItem & { missing: string[] }> = [];
  for (const i of items) {
    const found = extractRefs(`${i.title}\n${i.body}`, root, exists);
    if (found.missing.length > 0) dropped.push({ ...i, missing: found.missing });
    else kept.push({ ...i, refs: found.refs });
  }
  return { kept, dropped };
}
