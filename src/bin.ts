#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { connectClaudeCode } from "./claude-code/connect.js";
import { runClaudeCodeTap, type HookPayload } from "./claude-code/tap.js";
import { configPath, loadConfig, repoContext, saveConfig, spoolDir } from "./config.js";
import { Spool } from "./spool.js";

const USAGE = `meshpoint <command>

  login --base-url <url> --token <token>   store platform credentials (${configPath()})
  status                                   show config and the project for the current directory
  connect claude-code [--project <dir>] [--remove]
                                           install or remove the Claude Code hooks; --project writes
                                           <dir>/.claude/settings.json instead of the global settings
  tap claude-code                          hook entry point; reads one Claude Code payload on stdin
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "login": {
      const baseUrl = flag(rest, "--base-url");
      const token = flag(rest, "--token");
      if (!baseUrl || !token) throw new Error("login needs --base-url and --token");
      console.log(`saved ${saveConfig({ baseUrl, token })}`);
      return 0;
    }
    case "status": {
      const config = loadConfig();
      const repo = repoContext(process.cwd());
      console.log(JSON.stringify({ config: config ? { baseUrl: config.baseUrl, token: "set" } : null, repo }, null, 2));
      return 0;
    }
    case "connect": {
      if (rest[0] !== "claude-code") throw new Error("connect supports: claude-code");
      const project = flag(rest, "--project");
      if (project !== undefined && !path.isAbsolute(project)) throw new Error("--project must be an absolute path");
      console.log(connectClaudeCode({ remove: rest.includes("--remove"), ...(project ? { configDir: path.join(project, ".claude") } : {}) }));
      return 0;
    }
    case "tap": {
      if (rest[0] !== "claude-code") throw new Error("tap supports: claude-code");
      const config = loadConfig();
      const raw = await readStdin();
      let payload: HookPayload = {};
      try {
        payload = JSON.parse(raw) as HookPayload;
      } catch {
        payload = {};
      }
      if (!config) {
        process.stdout.write(payload.hook_event_name === "Stop" ? '{"decision":"continue"}' : "{}");
        return 0;
      }
      const out = await runClaudeCodeTap(payload, {
        config,
        repo: repoContext,
        readTranscript: (file) => readFileSync(file, "utf8"),
        spool: new Spool(spoolDir()),
      });
      process.stdout.write(out);
      return 0;
    }
    default:
      process.stdout.write(USAGE);
      return cmd === undefined || cmd === "--help" || cmd === "-h" ? 0 : 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    // The tap is the non-fatal boundary: a hook must never break the harness.
    if (process.argv[2] === "tap") {
      process.stdout.write("{}");
      process.exitCode = 0;
      return;
    }
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  },
);
