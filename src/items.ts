import { randomUUID } from "node:crypto";
import { KINDS, MeshpointClient, type ItemInput, type Kind } from "@meshpoint/sdk";
import type { Checkpoints } from "./checkpoints.js";
import type { Config, RepoContext } from "./config.js";
import { extractRefs, headSha } from "./refs.js";
import type { Touched } from "./touched.js";

export const ITEMS_MAX = 60;
export const ID_PREFIX_CHARS = 8;
const ALL_ITEMS_BUDGET = 100_000;
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

interface ItemDeps {
  config: Config;
  repo: RepoContext;
  fetch?: typeof fetch;
}

function clientFor(deps: ItemDeps): MeshpointClient {
  return new MeshpointClient({
    baseUrl: deps.config.baseUrl,
    token: deps.config.token,
    project: deps.repo.project,
    branch: deps.repo.branch,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
}

export interface PutDeps extends ItemDeps {
  checkpoints: Checkpoints;
  // Files edited on the branch since the last checkpoint ride along as the items' paths.
  touched?: Touched;
  now?: () => number;
  exists?: (abs: string) => boolean;
  sha?: (root: string) => string;
}

// Each item gets its refs (paths named in its text that exist in the checkout), the paths edited
// since the branch's last checkpoint, and HEAD. Path-like tokens that resolve to nothing come
// back as `missing` so the writer can fix a typo.
export async function putItems(drafts: ItemDraft[], deps: PutDeps): Promise<{ count: number; missing: string[] }> {
  const now = deps.now ?? Date.now;
  const { project, branch, root } = deps.repo;
  const since = deps.checkpoints.lastCheckpoint(project, branch);
  const paths = deps.touched?.since(project, branch, since) ?? [];
  const commit_sha = (deps.sha ?? headSha)(root);
  const missing = new Set<string>();
  const items: ItemInput[] = drafts.map((d) => {
    const found = extractRefs(`${d.title}\n${d.body}`, root, deps.exists);
    for (const m of found.missing) missing.add(m);
    return { id: randomUUID(), ...d, refs: found.refs, paths, ...(commit_sha ? { commit_sha } : {}) };
  });
  const out = await clientFor(deps).putItems(items);
  deps.checkpoints.markCheckpoint(project, branch, now());
  deps.touched?.clear(project, branch);
  return { ...out, missing: [...missing] };
}

// Resolves inject-style id prefixes against the branch's live items; ambiguous or unknown is an
// error, never a guess.
async function resolveIds(prefixes: readonly string[], deps: ItemDeps, client: MeshpointClient): Promise<string[]> {
  const { items } = await client.recall({ budget: ALL_ITEMS_BUDGET, fresh: true });
  return prefixes.map((prefix) => {
    const matches = items.filter((i) => i.id.startsWith(prefix)).map((i) => i.id);
    if (matches.length === 0) throw new Error(`no item on ${deps.repo.branch} starts with ${prefix}`);
    if (matches.length > 1) throw new Error(`${prefix} matches ${matches.length} items; give more characters`);
    return matches[0] as string;
  });
}

export async function confirmItems(prefixes: readonly string[], deps: ItemDeps): Promise<{ confirmed: string[] }> {
  if (prefixes.length === 0) throw new Error("confirm needs at least one item id");
  const client = clientFor(deps);
  const confirmed: string[] = [];
  for (const id of await resolveIds(prefixes, deps, client)) {
    if ((await client.confirm(id)).found) confirmed.push(id);
  }
  return { confirmed };
}

// The inject shows the first ID_PREFIX_CHARS of each id, so a retract takes a prefix and resolves it
// against the branch's live items; an ambiguous or unknown prefix is an error, never a guess.
export async function retractItems(prefixes: readonly string[], deps: ItemDeps): Promise<{ retracted: string[] }> {
  if (prefixes.length === 0) throw new Error("retract needs at least one item id");
  const client = clientFor(deps);
  const retracted: string[] = [];
  for (const id of await resolveIds(prefixes, deps, client)) {
    if ((await client.retract(id)).found) retracted.push(id);
  }
  return { retracted };
}
