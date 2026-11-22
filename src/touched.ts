import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

// Files the agent edited on a project branch, with the time, so a checkpoint can attach the
// paths worked on since the previous one. Hooks run as separate processes and `items put` runs
// as the agent's own command, so this lives on disk per project and branch, not per session.
export const TOUCHED_CAP = 500;

interface TouchedEntry {
  path: string;
  at: number;
}

export class Touched {
  constructor(private readonly dir: string) {}

  private file(project: string, branch: string): string {
    return path.join(this.dir, "touched", `${`${project}--${branch}`.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
  }

  private read(file: string): TouchedEntry[] {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      return Array.isArray(parsed) ? (parsed as TouchedEntry[]).filter((e) => typeof e?.path === "string" && typeof e?.at === "number") : [];
    } catch {
      return [];
    }
  }

  // One entry per path, newest time wins; the oldest entries fall off past the cap.
  append(project: string, branch: string, paths: readonly string[], at: number): void {
    if (paths.length === 0) return;
    const file = this.file(project, branch);
    const byPath = new Map(this.read(file).map((e) => [e.path, e.at]));
    for (const p of paths) byPath.set(p, Math.max(at, byPath.get(p) ?? 0));
    const entries = [...byPath].map(([p, t]) => ({ path: p, at: t })).sort((a, b) => a.at - b.at).slice(-TOUCHED_CAP);
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${JSON.stringify(entries)}\n`, { mode: 0o600 });
  }

  since(project: string, branch: string, at: number): string[] {
    return this.read(this.file(project, branch))
      .filter((e) => e.at > at)
      .map((e) => e.path);
  }

  clear(project: string, branch: string): void {
    rmSync(this.file(project, branch), { force: true });
  }
}
