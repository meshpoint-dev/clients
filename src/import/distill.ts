import { consolidatePrompt, parseMerged, parseProposedWith, renderTranscript, sessionPrompt as sharedSessionPrompt, type LiveItem, type MergedItem, type ProposedItem } from "@meshpoint/sdk";
import { extractRefs } from "../refs.js";
import type { DiscoveredSession } from "./discover.js";
import type { Runner } from "./runner.js";

// Turning transcripts into items with the user's own model: one call per session with the
// checkpoint skill's rules, then one call per branch that merges what the sessions proposed.
// The prompts and parsers live in @meshpoint/sdk, shared with the platform's Distill action.

export { BRANCH_ITEMS_MAX, consolidatePrompt, EVIDENCE_CHARS, HEAD_CHARS, parseMerged, parseProposed, parseProposedWith, renderTranscript, SESSION_ITEMS_MAX, TAIL_CHARS, type MergedItem, type ProposedItem } from "@meshpoint/sdk";

export function sessionPrompt(s: DiscoveredSession): string {
  return sharedSessionPrompt({ harness: s.harness, cwd: s.cwd, branch: s.branch, startedAt: s.startedAt }, renderTranscript(s.entries));
}

export async function distillSession(runner: Runner, s: DiscoveredSession): Promise<{ items: ProposedItem[]; unsupported: number }> {
  return parseProposedWith(await runner.run(sessionPrompt(s)), s.id, renderTranscript(s.entries));
}

export async function consolidate(runner: Runner, items: readonly ProposedItem[], live: readonly LiveItem[]): Promise<MergedItem[]> {
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
