import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Environment } from "../config.js";

// The user's own agent CLI as a bare model: one prompt in, one answer out, no tools, no project
// settings, on the user's subscription. Meshpoint never runs a model of its own.

export type RunnerName = "claude" | "codex";

export interface Runner {
  name: RunnerName;
  run(prompt: string): Promise<string>;
}

const SYSTEM = "You are a careful assistant. Follow the instructions in the message exactly. No tools, no preamble, output only what is asked.";
const TIMEOUT_MS = 10 * 60_000;

function onPath(bin: string, env: Environment): boolean {
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    try {
      execFileSync("test", ["-x", path.join(dir, bin)], { stdio: "ignore" });
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

// CLAUDE* variables are dropped so the CLI does not refuse to nest inside a running Claude Code session.
function cleanEnv(env: Environment): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([k, v]) => v !== undefined && !k.startsWith("CLAUDE"))) as Record<string, string>;
}

export function claudeRunner(env: Environment, model?: string): Runner {
  return {
    name: "claude",
    async run(prompt) {
      const args = ["-p", "--output-format", "json", "--no-session-persistence", "--tools", "", "--setting-sources", "", "--system-prompt", SYSTEM];
      if (model) args.push("--model", model);
      const dir = mkdtempSync(path.join(tmpdir(), "meshpoint-import-"));
      try {
        const res = spawnSync("claude", args, { input: prompt, env: cleanEnv(env), cwd: dir, timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
        if (res.status !== 0) throw new Error(`claude exited ${res.status}: ${(res.stderr ?? "").toString().slice(0, 300) || (res.stdout ?? "").toString().slice(0, 300)}`);
        const data = JSON.parse(res.stdout.toString()) as { result?: string; is_error?: boolean };
        if (data.is_error) throw new Error(`claude: ${String(data.result).slice(0, 300)}`);
        return data.result ?? "";
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

// codex exec writes the final message to a file; the prompt goes in on stdin.
export function codexRunner(env: Environment, model?: string): Runner {
  return {
    name: "codex",
    async run(prompt) {
      const dir = mkdtempSync(path.join(tmpdir(), "meshpoint-import-"));
      const out = path.join(dir, "last.md");
      try {
        const args = ["exec", "--skip-git-repo-check", "--sandbox", "read-only", "--output-last-message", out];
        if (model) args.push("-m", model);
        args.push("-");
        const res = spawnSync("codex", args, { input: `${SYSTEM}\n\n${prompt}`, env: cleanEnv(env), cwd: dir, timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
        if (res.status !== 0) throw new Error(`codex exited ${res.status}: ${(res.stderr ?? "").toString().slice(0, 300)}`);
        return readFileSync(out, "utf8");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

export function detectRunner(env: Environment, prefer?: RunnerName, model?: string): Runner | null {
  const order: RunnerName[] = prefer ? [prefer, ...(["claude", "codex"] as RunnerName[]).filter((n) => n !== prefer)] : ["claude", "codex"];
  for (const name of order) {
    if (!onPath(name, env)) continue;
    return name === "claude" ? claudeRunner(env, model) : codexRunner(env, model);
  }
  return null;
}

// The first JSON array or object in a model reply, code fences tolerated.
export function jsonBlock(text: string): unknown {
  let s = text.trim();
  if (s.startsWith("```")) {
    s = s.includes("\n") ? s.slice(s.indexOf("\n") + 1) : s.slice(3);
    s = s.lastIndexOf("```") >= 0 ? s.slice(0, s.lastIndexOf("```")) : s;
  }
  const starts = [s.indexOf("["), s.indexOf("{")].filter((i) => i >= 0);
  const start = starts.length ? Math.min(...starts) : 0;
  return JSON.parse(s.slice(start));
}
