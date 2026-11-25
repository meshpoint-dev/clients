#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectAntigravity } from "./antigravity/connect.js";
import { runAntigravityTap, type AntigravityHookPayload } from "./antigravity/tap.js";
import { connectClaudeCode } from "./claude-code/connect.js";
import { runClaudeCodeTap, type HookPayload } from "./claude-code/tap.js";
import { connectCodex } from "./codex/connect.js";
import { parseCodexTranscript } from "./codex/transcript.js";
import { connectCursor } from "./cursor/connect.js";
import { runCursorTap, type CursorHookPayload } from "./cursor/tap.js";
import { connectOpenclaw } from "./openclaw/connect.js";
import { connectOpencode } from "./opencode/connect.js";
import { ReplyLog, runOpenclawTap, type OpenclawEvent } from "./openclaw/tap.js";
import { connectPi } from "./pi/connect.js";
import { Checkpoints } from "./checkpoints.js";
import { configPath, deleteConfig, loadConfig, repoContext, saveConfig, spoolDir, stateDir, type Config } from "./config.js";
import { SessionCache } from "./context.js";
import { localChecks, Tap } from "./tap.js";
import { Touched } from "./touched.js";
import { MeshpointError } from "@meshpoint/sdk";
import { api, ApiError, canOpenBrowser, deviceLogin, freshConfig, login } from "./control.js";
import { detectHarnesses, renderDetected } from "./detect.js";
import { renderDoctor, runDoctor } from "./doctor.js";
import { branchItems, confirmItems, parseItemArgs, parseItems, putItems, retractItems } from "./items.js";
import { importOffer } from "./import/offer.js";
import { applyProposalFile, DEFAULT_SINCE_DAYS, importSessions } from "./import/run.js";
import { AGENTS_FILE, exportConventions, hasBlock } from "./agents-md.js";
import { connectMcp } from "./mcp/connect.js";
import { McpServer } from "./mcp/server.js";
import { MCP_INSTRUCTIONS, MCP_SERVER_NAME, meshpointTools } from "./mcp/tools.js";
import { detectRunner, type RunnerName } from "./import/runner.js";
import { Spool } from "./spool.js";

const IMPORT_USAGE = `  import sessions [--since <days>] [--all-repos] [--with-turns] [--apply | --propose] [--yes] [--fresh]
                 [--runner claude|codex] [--model <m>] [--min-turns <n>] [--from <items.json>] [--help]
                                           read this machine's harness transcripts (Claude Code, Codex, pi,
                                           opencode, Antigravity, Cursor) for the current repo and the last
                                           90 days, distill them into items with your own agent CLI, and
                                           write a proposal + report under ~/.local/state/meshpoint/import/.
                                           Every item carries a verbatim transcript quote as evidence;
                                           items without one are dropped. Per-session results are cached
                                           there too, so a rerun only distills new or changed sessions
                                           (--fresh ignores the cache). Items from a branch that is gone or
                                           already merged land on the default branch.
                                           Nothing is uploaded without --apply; older than 90 days or
                                           --all-repos asks first (--yes skips). --with-turns also uploads
                                           the last 30 days of turns as sessions. Review the saved
                                           items.json, delete or edit entries, then upload exactly that
                                           file with --apply --from <items.json>; or --propose sends the
                                           proposal to the console, where it is reviewed and applied.
`;

const USAGE = `meshpoint <command>

  login [--base-url <url>] [--agent <name>] [--org <id>] [--device | --browser]
                                           log in; stores tokens in ${configPath()}
                                           (default base url: https://api.meshpoint.dev). Opens a browser
                                           when one can run, else prints a code to approve in the console;
                                           --device or --browser forces one flow
  login --base-url <url> --token <token>   store a pasted agent token instead
  logout                                   end the session and delete the stored tokens
  whoami                                   account, org and role for the stored token
  status                                   show config and the project for the current directory
  --version                                print the installed version
  doctor [--json]                          check login, repo, connected harnesses, last capture, spool;
                                           exits 1 when something is wrong
  org                                      org, members and key ids
  org invite <email> [--role <role>]       invite by email (admins and owners; member, admin or owner;
                                           default member, admin and owner by owners only)
  org invites                              pending invites (admins and owners)
  org remove <user-id>                     remove a member and revoke their sessions (admins and owners)
  org role <user-id> <role>                set a member's role to member, admin or owner (owners only)
  org sessions                             logged-in agents (own; all for admins and owners)
  org revoke <session-id>                  revoke a session
  org rotate-key [--revoke-sessions]       rotate the org signing key (admins and owners)
  org projects                             projects recorded for the org
  connect [--json]                         list the harnesses on this machine and whether each is connected
  connect <harness> [--project <dir>] [--remove]
                                           install (or remove) the hooks and checkpoint skill for one harness
                                           in your user config, so every repo is covered; --project <dir>
                                           writes into that repo instead. Harnesses and their files:
    claude-code                            ~/.claude/settings.json + ~/.claude/skills/meshpoint
                                           (--project: <dir>/.claude/)
    codex                                  ~/.codex/{hooks.json,rules/meshpoint.rules} + ~/.agents/skills/meshpoint
                                           (--project: <dir>/.codex, <dir>/.agents)
    cursor                                 ~/.cursor/{hooks.json,skills/meshpoint} (--project: <dir>/.cursor)
    antigravity                            ~/.gemini/config/{hooks.json,skills/meshpoint}
                                           (--project: <dir>/.agents)
    pi [--pi-dir <dir>]                    <dir>/extensions/meshpoint.js + <dir>/skills/meshpoint
                                           (default dir: $PI_CODING_AGENT_DIR or ~/.pi/agent)
    opencode [--config-dir <dir>]          <dir>/plugins/meshpoint.js + <dir>/skills/meshpoint
                                           (default dir: ~/.config/opencode)
    openclaw                               hook pack installed through 'openclaw plugins install'
    mcp                                    prints where MCP clients take the server; --project <dir>
                                           writes <dir>/.mcp.json (Claude Code project scope, VS Code
                                           with Copilot)
  mcp [--cwd <dir>]                        stdio MCP server for clients without a hook: tools for recall,
                                           file context and item writes; the repository is the working
                                           directory
  items put --item <kind> <title> <body> [--item ...]
  items put --file <path> | items put < items.json
                                           write items for the current repo and branch; the file or
                                           stdin form takes a JSON array of {kind, title, body}
  items retract <id>...                    retract items on the current branch; an id may be a prefix
  items confirm <id>...                    confirm items on the current branch (counts toward their rank)
  export agents [--file <path>] [--check]  write the branch's conventions as a marked block in AGENTS.md
                                           (or --file, repo-relative) for agents that read that file
                                           without a hook; the block is the only part touched, rerun to
                                           refresh. --check exits 1 when the block is out of date
${IMPORT_USAGE}  tap claude-code | codex | cursor | antigravity [<event>] | openclaw
                                           hook entry point; reads one hook payload on stdin
`;


const TAP_HARNESSES = new Set(["claude-code", "codex", "cursor", "antigravity", "openclaw"]);

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function installedVersion(): string {
  return (JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { version: string }).version;
}

const DEFAULT_BASE_URL = "https://api.meshpoint.dev";

async function requireConfig(): Promise<Config> {
  const config = loadConfig();
  if (!config) throw new Error(`not logged in; run meshpoint login (${configPath()})`);
  return freshConfig(config);
}

// A 401 on a stored session token means the org key rotated or the token was revoked early:
// refresh once and retry before giving up.
async function withAuth<T>(config: Config, fn: (c: Config) => Promise<T>): Promise<T> {
  try {
    return await fn(config);
  } catch (err) {
    const status = err instanceof ApiError || err instanceof MeshpointError ? err.status : 0;
    if (status !== 401 || !config.refresh) throw err;
    return fn(await freshConfig(config, { force: true }));
  }
}

async function orgCommand(args: string[], config: Config): Promise<unknown> {
  const call = (method: string, path: string, body?: unknown) => api(config.baseUrl, method, path, { token: config.token, ...(body === undefined ? {} : { body }) });
  switch (args[0]) {
    case undefined:
      return call("GET", "/v1/org");
    case "invite": {
      if (!args[1]) throw new Error("org invite needs an email");
      const at = args.indexOf("--role");
      return call("POST", "/v1/org/invites", { email: args[1], role: at === -1 ? "member" : args[at + 1] });
    }
    case "invites":
      return call("GET", "/v1/org/invites");
    case "remove": {
      if (!args[1]) throw new Error("org remove needs a user id");
      return call("DELETE", `/v1/org/members/${encodeURIComponent(args[1])}`);
    }
    case "role": {
      if (!args[1] || !args[2]) throw new Error("org role needs a user id and a role");
      return call("PATCH", `/v1/org/members/${encodeURIComponent(args[1])}`, { role: args[2] });
    }
    case "sessions":
      return call("GET", "/v1/org/sessions");
    case "revoke": {
      if (!args[1]) throw new Error("org revoke needs a session id");
      return call("POST", "/v1/org/sessions/revoke", { id: args[1] });
    }
    case "rotate-key":
      return call("POST", "/v1/org/keys/rotate", { revoke_sessions: args.includes("--revoke-sessions") });
    case "projects":
      return call("GET", "/v1/org/projects");
    default:
      throw new Error("org supports: invite, invites, remove, role, sessions, revoke, rotate-key, projects");
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "--version":
    case "-v":
    case "version": {
      process.stdout.write(`${installedVersion()}\n`);
      return 0;
    }
    case "login": {
      const baseUrl = flag(rest, "--base-url") ?? DEFAULT_BASE_URL;
      const token = flag(rest, "--token");
      if (token) {
        console.log(`saved ${saveConfig({ baseUrl, token })}`);
        return 0;
      }
      const agent = flag(rest, "--agent");
      const org = flag(rest, "--org");
      const useDevice = rest.includes("--device") || (!rest.includes("--browser") && !canOpenBrowser());
      const config = useDevice
        ? await deviceLogin({ baseUrl, ...(agent ? { agent } : {}), log: (line) => console.log(line) })
        : await login({ baseUrl, ...(agent ? { agent } : {}), ...(org ? { org } : {}), log: (line) => console.error(line) });
      console.log(`logged in as ${config.email} (org ${config.orgName}); saved ${saveConfig(config)}`);
      return 0;
    }
    case "logout": {
      const config = loadConfig();
      if (config?.refresh) await api(config.baseUrl, "POST", "/v1/auth/logout", { body: { refresh: config.refresh } }).catch(() => undefined);
      deleteConfig();
      console.log(`removed ${configPath()}`);
      return 0;
    }
    case "whoami": {
      const config = await requireConfig();
      console.log(JSON.stringify(await withAuth(config, (c) => api(c.baseUrl, "GET", "/v1/me", { token: c.token })), null, 2));
      return 0;
    }
    case "org": {
      const config = await requireConfig();
      console.log(JSON.stringify(await withAuth(config, (c) => orgCommand(rest, c)), null, 2));
      return 0;
    }
    case "status": {
      const config = loadConfig();
      const repo = repoContext(process.cwd());
      console.log(JSON.stringify({ config: config ? { baseUrl: config.baseUrl, token: "set" } : null, repo }, null, 2));
      return 0;
    }
    case "doctor": {
      const report = await runDoctor();
      console.log(rest.includes("--json") ? JSON.stringify(report, null, 2) : renderDoctor(report));
      return report.ok ? 0 : 1;
    }
    case "connect": {
      if (rest[0] === undefined || rest[0] === "--json") {
        const rows = detectHarnesses();
        console.log(rest.includes("--json") ? JSON.stringify(rows, null, 2) : renderDetected(rows));
        return 0;
      }
      const project = flag(rest, "--project");
      if (project !== undefined && !path.isAbsolute(project)) throw new Error("--project must be an absolute path");
      const piDir = flag(rest, "--pi-dir");
      if (piDir !== undefined && !path.isAbsolute(piDir)) throw new Error("--pi-dir must be an absolute path");
      const configDir = flag(rest, "--config-dir");
      if (configDir !== undefined && !path.isAbsolute(configDir)) throw new Error("--config-dir must be an absolute path");
      const remove = rest.includes("--remove");
      const inProject = project ? { projectDir: project } : {};
      if (rest[0] === "claude-code") console.log(connectClaudeCode({ remove, ...(project ? { configDir: path.join(project, ".claude") } : {}) }));
      else if (rest[0] === "codex") console.log(connectCodex({ remove, ...inProject }));
      else if (rest[0] === "cursor") console.log(connectCursor({ remove, ...inProject }));
      else if (rest[0] === "antigravity") console.log(connectAntigravity({ remove, ...inProject }));
      else if (rest[0] === "pi") console.log(connectPi({ remove, ...(piDir ? { piDir } : {}) }));
      else if (rest[0] === "openclaw") console.log(connectOpenclaw({ remove }));
      else if (rest[0] === "opencode") console.log(connectOpencode({ remove, ...(configDir ? { configDir } : {}) }));
      else if (rest[0] === "mcp") console.log(connectMcp({ remove, ...inProject }));
      else throw new Error("connect supports: claude-code, codex, cursor, antigravity, pi, opencode, openclaw, mcp");
      if (!remove && rest[0] !== "mcp") {
        // Past sessions for this repository are worth a line; the offer never fails the connect.
        try {
          const repo = repoContext(process.cwd());
          const offer = importOffer({ repo, env: process.env, runner: detectRunner(process.env)?.name ?? null });
          if (offer) console.log(`\n${offer}`);
          if (repo && !hasBlock(repo.root)) console.log(`\nAgents without a hook read ${AGENTS_FILE}: meshpoint export agents writes the team's conventions there.`);
        } catch {
          // unreadable store or no git
        }
      }
      return 0;
    }
    case "items": {
      if (rest[0] !== "put" && rest[0] !== "retract" && rest[0] !== "confirm") throw new Error("items supports: put, retract, confirm");
      const config = await requireConfig();
      const repo = repoContext(process.cwd());
      if (!repo) throw new Error("not inside a git repo with an origin remote");
      if (rest[0] === "retract") {
        console.log(JSON.stringify(await withAuth(config, (c) => retractItems(rest.slice(1), { config: c, repo }))));
        return 0;
      }
      if (rest[0] === "confirm") {
        console.log(JSON.stringify(await withAuth(config, (c) => confirmItems(rest.slice(1), { config: c, repo }))));
        return 0;
      }
      const file = flag(rest, "--file");
      const drafts = rest.includes("--item") ? parseItemArgs(rest.slice(1)) : parseItems(file ? readFileSync(file, "utf8") : await readStdin());
      const { missing, ...out } = await withAuth(config, (c) => putItems(drafts, { config: c, repo, checkpoints: new Checkpoints(stateDir()), touched: new Touched(stateDir()) }));
      for (const m of missing) console.error(`ref not found: ${m}`);
      console.log(JSON.stringify({ ...out, project: repo.project, branch: repo.branch }));
      return 0;
    }
    case "mcp": {
      const cwd = flag(rest, "--cwd") ?? process.cwd();
      if (!path.isAbsolute(cwd)) throw new Error("--cwd must be an absolute path");
      const stored = loadConfig();
      const config = stored ? await freshConfig(stored).catch(() => stored) : null;
      const repo = repoContext(cwd);
      const tap =
        config && repo
          ? new Tap({
              config,
              repo,
              session: `mcp-${randomUUID()}`,
              spool: new Spool(spoolDir()),
              checkpoints: new Checkpoints(stateDir()),
              touched: new Touched(stateDir()),
              cache: new SessionCache(stateDir()),
              local: localChecks(repo.root),
              refresh: () => freshConfig(config, { force: true }).catch(() => null),
            })
          : null;
      const server = new McpServer({
        name: MCP_SERVER_NAME,
        version: installedVersion(),
        instructions: MCP_INSTRUCTIONS,
        tools: meshpointTools({ tap, cwd, config: requireConfig, checkpoints: new Checkpoints(stateDir()), touched: new Touched(stateDir()) }),
      });
      await server.serve(process.stdin, process.stdout);
      return 0;
    }
    case "export": {
      if (rest[0] !== "agents") throw new Error("export supports: agents");
      const config = await requireConfig();
      const repo = repoContext(process.cwd());
      if (!repo) throw new Error("not inside a git repo with an origin remote");
      const file = flag(rest, "--file");
      if (file !== undefined && (path.isAbsolute(file) || file.split(/[\\/]/).includes(".."))) throw new Error("--file is a path inside the repository");
      const check = rest.includes("--check");
      const items = await withAuth(config, (c) => branchItems({ config: c, repo }));
      const out = exportConventions(items, repo.root, { ...(file ? { file } : {}), check });
      const what = `${out.count} convention${out.count === 1 ? "" : "s"} on ${repo.branch}`;
      if (check) console.log(out.changed ? `${out.file} is out of date (${what}); run meshpoint export agents` : `${out.file} is up to date (${what})`);
      else console.log(out.changed ? `${out.created ? "created" : "updated"} ${out.file}: ${what}. Commit it so every agent and teammate reads it.` : `${out.file} already up to date (${what})`);
      return check && out.changed ? 1 : 0;
    }
    case "import": {
      if (rest[0] !== "sessions") throw new Error("import supports: sessions");
      if (rest.includes("--help") || rest.includes("-h")) {
        process.stdout.write(IMPORT_USAGE);
        return 0;
      }
      const config = await requireConfig();
      const repo = repoContext(process.cwd());
      const from = flag(rest, "--from");
      if (from !== undefined) {
        if (!rest.includes("--apply")) throw new Error("--from goes with --apply: it uploads a reviewed proposal file");
        await withAuth(config, (c) => applyProposalFile({ config: c, file: from, current: repo ? { project: repo.project, root: repo.root } : null }));
        return 0;
      }
      const sinceDays = Number(flag(rest, "--since") ?? DEFAULT_SINCE_DAYS);
      if (!Number.isInteger(sinceDays) || sinceDays < 1) throw new Error("--since takes a whole number of days");
      const minTurns = Number(flag(rest, "--min-turns") ?? 6);
      const prefer = flag(rest, "--runner") as RunnerName | undefined;
      if (prefer !== undefined && prefer !== "claude" && prefer !== "codex") throw new Error("--runner takes claude or codex");
      const model = flag(rest, "--model");
      const runner = detectRunner(process.env, prefer, model);
      if (!runner) throw new Error("no agent CLI found on PATH (claude or codex); install one to distill transcripts, or write items by hand with meshpoint items put");
      const defaultBranch = repo ? repo.branch : "master";
      const out = await withAuth(config, (c) =>
        importSessions({
          config: c,
          current: repo ? { project: repo.project, root: repo.root, defaultBranch } : null,
          sinceDays,
          allRepos: rest.includes("--all-repos"),
          withTurns: rest.includes("--with-turns"),
          apply: rest.includes("--apply"),
          propose: rest.includes("--propose"),
          yes: rest.includes("--yes"),
          fresh: rest.includes("--fresh"),
          minTurns,
          runner,
          stateDir: stateDir(),
        }),
      );
      return out.cancelled ? 1 : 0;
    }
    case "tap": {
      const harness = rest[0];
      if (!TAP_HARNESSES.has(harness ?? "")) throw new Error(`tap supports: ${[...TAP_HARNESSES].join(", ")}`);
      const stored = loadConfig();
      // A failed refresh keeps the stored token: the hook must never break the harness.
      const config = stored ? await freshConfig(stored).catch(() => stored) : null;
      const raw = await readStdin();
      const parse = <T>(): T => {
        try {
          return JSON.parse(raw) as T;
        } catch {
          return {} as T;
        }
      };
      const hookDeps = (c: Config) => ({
        config: c,
        refresh: () => freshConfig(c, { force: true }).catch(() => null),
        repo: repoContext,
        readTranscript: (file: string) => readFileSync(file, "utf8"),
        spool: new Spool(spoolDir()),
        checkpoints: new Checkpoints(stateDir()),
        touched: new Touched(stateDir()),
        cache: new SessionCache(stateDir()),
        local: (root: string) => localChecks(root, harness),
      });
      // Each harness has its own "do nothing" answer, needed even without a login.
      if (harness === "cursor") {
        const payload = parse<CursorHookPayload>();
        if (!config) process.stdout.write(payload.hook_event_name === "beforeSubmitPrompt" ? '{"continue":true}' : "{}");
        else process.stdout.write(await runCursorTap(payload, hookDeps(config)));
        return 0;
      }
      if (harness === "antigravity") {
        // Antigravity payloads carry no event name; the installed command passes it as an argument.
        let payload = parse<AntigravityHookPayload>();
        if (rest[1]) payload = { ...payload, hookEventName: rest[1] };
        if (!config) process.stdout.write(payload.hookEventName === "Stop" ? '{"decision":"stop"}' : "{}");
        else process.stdout.write(await runAntigravityTap(payload, { ...hookDeps(config), stateDir: stateDir() }));
        return 0;
      }
      if (harness === "openclaw") {
        if (!config) process.stdout.write("{}");
        else {
          const { readTranscript: _unused, ...deps } = hookDeps(config);
          process.stdout.write(await runOpenclawTap(parse<OpenclawEvent>(), { ...deps, env: process.env, replies: new ReplyLog(stateDir()) }));
        }
        return 0;
      }
      const payload = parse<HookPayload>();
      if (!config) {
        process.stdout.write(payload.hook_event_name === "Stop" ? '{"decision":"continue"}' : "{}");
        return 0;
      }
      process.stdout.write(await runClaudeCodeTap(payload, { ...hookDeps(config), ...(harness === "codex" ? { parseTranscript: parseCodexTranscript } : {}) }));
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
