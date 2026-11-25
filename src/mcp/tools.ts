import { KINDS } from "@meshpoint/sdk";
import type { Checkpoints } from "../checkpoints.js";
import type { Config, RepoContext } from "../config.js";
import { confirmItems, ITEMS_MAX, parseItems, putItems, retractItems } from "../items.js";
import type { Tap } from "../tap.js";
import type { Touched } from "../touched.js";
import type { ToolDef } from "./server.js";

// The Meshpoint tools an MCP client gets: the session-start context, the notice for one file,
// and the three item writes. Capture and presence need a hook or plugin and are not here.

export const MCP_SERVER_NAME = "meshpoint";

export interface ToolDeps {
  // Null when the server started outside a repository with an origin remote.
  tap: Tap | null;
  cwd: string;
  config: () => Promise<Config>;
  checkpoints: Checkpoints;
  touched: Touched;
  fetch?: typeof fetch;
}

export const MCP_INSTRUCTIONS = `Meshpoint is the team's shared memory for this repository, per branch.
Call meshpoint_recall once at the start of a task: it lists what teammates' agents learned (decisions, gotchas, conventions, facts, status, todos) and who is active now. Before editing a file, meshpoint_file_context tells you what is known about that file and whether a teammate is on it.
Record what you establish with meshpoint_items_put: one item per decision, gotcha, convention, fact, status or todo, bodies concrete (repo-relative file names, commands, values, reasons), nothing already listed by recall unless it changed, no secrets. Retract items you proved wrong with meshpoint_items_retract.`;

const IDS_SCHEMA = { type: "array", items: { type: "string" }, minItems: 1, description: "Item ids or unique id prefixes, as recall lists them." };

function strings(v: unknown, what: string): string[] {
  if (!Array.isArray(v) || v.length === 0 || !v.every((s) => typeof s === "string" && s.trim())) throw new Error(`${what} must be a non-empty list of strings`);
  return v.map((s: string) => s.trim());
}

export function meshpointTools(deps: ToolDeps): ToolDef[] {
  const tap = (): Tap => {
    if (!deps.tap) throw new Error(`${deps.cwd} is not inside a git repository with an origin remote; start the server in one or pass --cwd`);
    return deps.tap;
  };
  const repo = (): RepoContext => tap().repo;
  const itemDeps = async () => ({ config: await deps.config(), repo: repo(), ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  return [
    {
      name: "meshpoint_recall",
      description: "Team knowledge for this repository and branch: items from teammates' agents (first column is the item id, ? marks an item whose referenced file changed since) and who is active now. Call once at the start of a task.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: async () => {
        const text = await tap().start();
        return text || `No team knowledge for ${repo().project} @ ${repo().branch} yet.`;
      },
    },
    {
      name: "meshpoint_file_context",
      description: "What is known about one file before you edit it: items naming it and teammates editing it now. Path is repo-relative or absolute.",
      inputSchema: { type: "object", properties: { path: { type: "string", description: "File path, repo-relative or absolute." } }, required: ["path"], additionalProperties: false },
      run: async (args) => {
        if (typeof args.path !== "string" || !args.path.trim()) throw new Error("path is required");
        const text = await tap().fileContext(args.path.trim());
        return text || `Nothing recorded about ${args.path.trim()}; nobody else is on it.`;
      },
    },
    {
      name: "meshpoint_items_put",
      description: `Write knowledge items for this repository and branch. Each item: kind (${KINDS.join(", ")}), one-line title, one to three concrete sentences as body; optional key (a stable slot such as test-runner; a later item with the same key replaces this one) and supersedes (ids this item replaces). At most ${ITEMS_MAX} per call. Name files by repo-relative path; the result lists paths that do not exist in the checkout.`,
      inputSchema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            minItems: 1,
            maxItems: ITEMS_MAX,
            items: {
              type: "object",
              properties: {
                kind: { type: "string", enum: [...KINDS] },
                title: { type: "string" },
                body: { type: "string" },
                key: { type: "string" },
                supersedes: { type: "array", items: { type: "string" } },
              },
              required: ["kind", "title", "body"],
              additionalProperties: false,
            },
          },
        },
        required: ["items"],
        additionalProperties: false,
      },
      run: async (args) => {
        const drafts = parseItems(JSON.stringify(args.items ?? null));
        const { missing, ...out } = await putItems(drafts, { ...(await itemDeps()), checkpoints: deps.checkpoints, touched: deps.touched });
        return JSON.stringify({ ...out, project: repo().project, branch: repo().branch, ...(missing.length ? { ref_not_found: missing } : {}) });
      },
    },
    {
      name: "meshpoint_items_retract",
      description: "Retract items on this branch that this session proved wrong: a finished todo, a reversed decision with nothing in its place.",
      inputSchema: { type: "object", properties: { ids: IDS_SCHEMA }, required: ["ids"], additionalProperties: false },
      run: async (args) => JSON.stringify(await retractItems(strings(args.ids, "ids"), await itemDeps())),
    },
    {
      name: "meshpoint_items_confirm",
      description: "Confirm items that held true in this session; confirmations raise an item in recall and keep status and todo items from expiring.",
      inputSchema: { type: "object", properties: { ids: IDS_SCHEMA }, required: ["ids"], additionalProperties: false },
      run: async (args) => JSON.stringify(await confirmItems(strings(args.ids, "ids"), await itemDeps())),
    },
  ];
}
