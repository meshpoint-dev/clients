import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

// Hook processes live for one event, so turns are batched on disk: one JSONL file per harness
// session, sent once the oldest line is older than FLUSH_AFTER_MS or the session ends.
export interface SpooledTurn {
  branch: string;
  body: string;
  paths?: string[];
  at: number;
}

export const FLUSH_AFTER_MS = 60_000;

export class Spool {
  constructor(private readonly dir: string) {}

  private file(session: string): string {
    return path.join(this.dir, `${session.replace(/[^A-Za-z0-9._-]/g, "_")}.jsonl`);
  }

  append(session: string, turn: SpooledTurn): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    appendFileSync(this.file(session), `${JSON.stringify(turn)}\n`, { mode: 0o600 });
  }

  read(session: string): SpooledTurn[] {
    let raw: string;
    try {
      raw = readFileSync(this.file(session), "utf8");
    } catch {
      return [];
    }
    const out: SpooledTurn[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as SpooledTurn);
      } catch {
        continue;
      }
    }
    return out;
  }

  isDue(session: string, now: number, force: boolean): boolean {
    const turns = this.read(session);
    if (turns.length === 0) return false;
    return force || now - (turns[0]?.at ?? now) >= FLUSH_AFTER_MS;
  }

  // Moves the file aside first so a hook running concurrently appends to a fresh file; the
  // caller sends the returned turns and calls `discard` on success or `restore` on failure.
  take(session: string): { turns: SpooledTurn[]; discard: () => void; restore: () => void } {
    const file = this.file(session);
    const taken = `${file}.${process.pid}.${Date.now()}.sending`;
    try {
      renameSync(file, taken);
    } catch {
      return { turns: [], discard: () => undefined, restore: () => undefined };
    }
    const turns = this.readFile(taken);
    return {
      turns,
      discard: () => rmSync(taken, { force: true }),
      restore: () => {
        // Prepend what was taken to whatever arrived meanwhile, keeping order.
        const newer = this.read(session);
        rmSync(file, { force: true });
        for (const t of [...turns, ...newer]) this.append(session, t);
        rmSync(taken, { force: true });
      },
    };
  }

  private readFile(file: string): SpooledTurn[] {
    try {
      return readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as SpooledTurn);
    } catch {
      return [];
    }
  }
}
