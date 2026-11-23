import type { DiscoveredSession } from "./discover.js";
import type { MergedItem } from "./distill.js";

// What the import found and proposes, per project. Printed and saved beside items.json.

export interface BranchResult {
  branch: string;
  items: Array<MergedItem & { refs: string[] }>;
  dropped: Array<MergedItem & { missing: string[] }>;
}

export interface ProjectResult {
  project: string;
  root: string;
  sessions: DiscoveredSession[];
  branches: BranchResult[];
  errors: string[];
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function topPaths(sessions: readonly DiscoveredSession[], max = 8): string[] {
  const counts = new Map<string, number>();
  for (const s of sessions) for (const e of s.entries) for (const p of e.paths) counts.set(p, (counts.get(p) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, max).map(([p, n]) => `${p} (${n})`);
}

export function renderReport(results: readonly ProjectResult[], unmapped: readonly DiscoveredSession[], skipped: Record<string, string>): string {
  const lines: string[] = [];
  for (const r of results) {
    const byHarness = new Map<string, number>();
    for (const s of r.sessions) byHarness.set(s.harness, (byHarness.get(s.harness) ?? 0) + 1);
    const turns = r.sessions.reduce((n, s) => n + s.entries.length, 0);
    const first = Math.min(...r.sessions.map((s) => s.startedAt));
    const last = Math.max(...r.sessions.map((s) => s.endedAt));
    lines.push(`== ${r.project}`, `${plural(r.sessions.length, "session")} (${[...byHarness].map(([h, n]) => `${h} ${n}`).join(", ")}), ${plural(turns, "turn")}, ${new Date(first).toISOString().slice(0, 10)} to ${new Date(last).toISOString().slice(0, 10)}`);
    const paths = topPaths(r.sessions);
    if (paths.length) lines.push(`most touched: ${paths.join(", ")}`);
    for (const b of r.branches) {
      const kinds = new Map<string, number>();
      for (const i of b.items) kinds.set(i.kind, (kinds.get(i.kind) ?? 0) + 1);
      lines.push("", `-- ${b.branch}: ${plural(b.items.length, "item")} proposed (${[...kinds].map(([k, n]) => `${n} ${k}`).join(", ") || "none"})${b.dropped.length ? `, ${b.dropped.length} dropped for naming files that are gone` : ""}`);
      const recurring = b.items.filter((i) => i.recurring);
      if (recurring.length) {
        lines.push("recurring gotchas:");
        for (const i of recurring) lines.push(`  * ${i.title} (${plural(i.sessions.length, "session")})`);
      }
      for (const i of b.items.filter((x) => !x.recurring)) lines.push(`  - [${i.kind}] ${i.title}${i.key ? ` #${i.key}` : ""}`);
      for (const d of b.dropped) lines.push(`  x [${d.kind}] ${d.title}: missing ${d.missing.join(", ")}`);
    }
    for (const e of r.errors) lines.push(`! ${e}`);
    lines.push("");
  }
  if (unmapped.length) {
    const byHarness = new Map<string, number>();
    for (const s of unmapped) byHarness.set(s.harness, (byHarness.get(s.harness) ?? 0) + 1);
    lines.push(`${plural(unmapped.length, "session")} could not be mapped to a repository (${[...byHarness].map(([h, n]) => `${h} ${n}`).join(", ")}): the recorded directory is gone, has no origin remote, or the store records no directory.`);
  }
  for (const [h, why] of Object.entries(skipped)) lines.push(`${h}: ${why}`);
  return lines.join("\n");
}
