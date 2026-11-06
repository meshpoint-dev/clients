import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { TranscriptEntry } from "./claude-code/transcript.js";

// A checkpoint is the agent writing items for a project branch. Its time is recorded here so the
// Stop hook can tell how much of the session has gone unrecorded. Nudges are recorded per harness
// session so an ignored nudge is not repeated on every Stop.
export const CHECKPOINT_TURNS = 20;
export const CHECKPOINT_CHARS = 60_000;

function safe(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_");
}

export class Checkpoints {
  constructor(private readonly dir: string) {}

  private file(kind: "checkpoints" | "nudges", name: string): string {
    return path.join(this.dir, kind, `${safe(name)}.json`);
  }

  private readAt(file: string): number {
    try {
      const v = (JSON.parse(readFileSync(file, "utf8")) as { at?: unknown }).at;
      return typeof v === "number" ? v : 0;
    } catch {
      return 0;
    }
  }

  private writeAt(file: string, at: number): void {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${JSON.stringify({ at })}\n`, { mode: 0o600 });
  }

  lastCheckpoint(project: string, branch: string): number {
    return this.readAt(this.file("checkpoints", `${project}--${branch}`));
  }

  markCheckpoint(project: string, branch: string, at: number): void {
    this.writeAt(this.file("checkpoints", `${project}--${branch}`), at);
  }

  lastNudge(session: string): number {
    return this.readAt(this.file("nudges", session));
  }

  markNudge(session: string, at: number): void {
    this.writeAt(this.file("nudges", session), at);
  }

  // Due when the assistant has produced enough since the later of the last checkpoint and the
  // last nudge: CHECKPOINT_TURNS replies or CHECKPOINT_CHARS of text.
  due(session: string, project: string, branch: string, entries: readonly TranscriptEntry[]): { turns: number; chars: number } | null {
    const since = Math.max(this.lastCheckpoint(project, branch), this.lastNudge(session));
    let turns = 0;
    let chars = 0;
    for (const e of entries) {
      if (e.role !== "assistant" || e.at <= since) continue;
      turns += 1;
      chars += e.text.length;
    }
    return turns >= CHECKPOINT_TURNS || chars >= CHECKPOINT_CHARS ? { turns, chars } : null;
  }
}
