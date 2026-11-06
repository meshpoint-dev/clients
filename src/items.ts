import { randomUUID } from "node:crypto";
import { KINDS, MeshpointClient, type ItemInput, type Kind } from "@meshpoint/sdk";
import type { Checkpoints } from "./checkpoints.js";
import type { Config, RepoContext } from "./config.js";

export const ITEMS_MAX = 60;
const TITLE_MAX = 200;
const BODY_MAX = 2000;

export interface ItemDraft {
  kind: Kind;
  title: string;
  body: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function draft(i: number | string, kind: unknown, title: unknown, body: unknown): ItemDraft {
  if (typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind)) throw new Error(`item ${i}: kind must be one of ${KINDS.join(", ")}`);
  if (typeof title !== "string" || !title.trim()) throw new Error(`item ${i}: title required`);
  if (typeof body !== "string" || !body.trim()) throw new Error(`item ${i}: body required`);
  return { kind: kind as Kind, title: title.trim().slice(0, TITLE_MAX), body: body.trim().slice(0, BODY_MAX) };
}

// `--item <kind> <title> <body>`, repeated. Plain arguments: no JSON for a shell guard to object to.
export function parseItemArgs(args: readonly string[]): ItemDraft[] {
  const drafts: ItemDraft[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== "--item") throw new Error(`unexpected argument ${args[i]}`);
    drafts.push(draft(drafts.length, args[i + 1], args[i + 2], args[i + 3]));
    i += 3;
  }
  if (drafts.length === 0) throw new Error("no items");
  if (drafts.length > ITEMS_MAX) throw new Error(`at most ${ITEMS_MAX} items per put`);
  return drafts;
}

// Parses the agent's JSON array of {kind, title, body}; anything else is a usage error.
export function parseItems(raw: string): ItemDraft[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("items must be a JSON array of {kind, title, body}");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("items must be a non-empty JSON array");
  if (parsed.length > ITEMS_MAX) throw new Error(`at most ${ITEMS_MAX} items per put`);
  return parsed.map((v, i) => {
    if (!isRecord(v)) throw new Error(`item ${i}: not an object`);
    return draft(i, v.kind, v.title, v.body);
  });
}

export async function putItems(
  drafts: ItemDraft[],
  deps: { config: Config; repo: RepoContext; checkpoints: Checkpoints; now?: () => number; fetch?: typeof fetch },
): Promise<{ count: number }> {
  const now = deps.now ?? Date.now;
  const client = new MeshpointClient({
    baseUrl: deps.config.baseUrl,
    token: deps.config.token,
    project: deps.repo.project,
    branch: deps.repo.branch,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  const items: ItemInput[] = drafts.map((d) => ({ id: randomUUID(), ...d }));
  const out = await client.putItems(items);
  deps.checkpoints.markCheckpoint(deps.repo.project, deps.repo.branch, now());
  return out;
}
