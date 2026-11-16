import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// The hook pack OpenClaw copies into <state dir>/hooks/<PACK_NAME>/. It carries no dependencies:
// the handler shells out to the meshpoint CLI, which owns login, spooling and the platform calls.
export const PACK_NAME = "meshpoint-openclaw";
export const HOOK_NAME = "meshpoint";
export const OPENCLAW_TAP_COMMAND = "meshpoint tap openclaw";

// Exact keys only: a family key ("message") next to an exact one would fire the handler twice.
export const EVENTS = ["agent:bootstrap", "message:received", "message:sent", "command:new", "command:reset", "session:auto-reset"] as const;

const HOOK_MD = `---
name: ${HOOK_NAME}
description: "Meshpoint team memory: recall injected at agent bootstrap, turns captured through the meshpoint CLI"
homepage: https://meshpoint.dev
metadata:
  {
    "openclaw":
      {
        "events": ${JSON.stringify(EVENTS)},
        "requires": { "bins": ["meshpoint"] },
      },
  }
---

# Meshpoint

Hands every event to \`${OPENCLAW_TAP_COMMAND}\` as JSON on stdin. The CLI must be logged in
(\`meshpoint login\`) on the Gateway host and on the Gateway's PATH.

- **agent:bootstrap**: fetches team knowledge, the last checkpoint and active teammates for the
  project, and adds them to the bootstrap context (refreshed every 15 minutes per session).
- **message:received** / **message:sent**: records the user and assistant turns.
- **command:new**, **command:reset**, **session:auto-reset**: flushes what is still spooled.

The project is the origin remote of the agent workspace when it is a git checkout. For a chat
agent without a repo, set \`MESHPOINT_PROJECT\` (and optionally \`MESHPOINT_BRANCH\`, default
\`main\`) in the Gateway's environment. Without either, the hook does nothing.

Every call is fail-quiet: a broken or unreachable platform never blocks a reply.

Remove with \`meshpoint connect openclaw --remove\`.
`;

const HANDLER_JS = `// Meshpoint hook for OpenClaw. Each event is handed to the meshpoint CLI as JSON on stdin; this
// module only keeps what must live between events: the workspace directory, the context block to
// inject at bootstrap, and a pending checkpoint nudge. Failures are swallowed so the Gateway is
// never blocked; set MESHPOINT_HOOK_DEBUG=1 to see them in the Gateway log.
import { execFile } from "node:child_process";

const TIMEOUT_MS = 20_000;
const INJECT_TTL_MS = 15 * 60_000;
const MAX_SESSIONS = 256;
const injects = new Map();
const nudges = new Map();
let workspaceDir;

const str = (v) => (typeof v === "string" ? v : undefined);

function debug(message) {
  if (process.env.MESHPOINT_HOOK_DEBUG) console.warn(\`[meshpoint] \${message}\`);
}

function remember(map, key, value) {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_SESSIONS) map.delete(map.keys().next().value);
}

// Message events carry only the session key and bootstrap carries both, so the nudge is filed
// under every id the event names and looked up the same way.
function sessionOf(event) {
  return str(event.sessionKey) || str(event.context?.sessionId) || "unknown";
}

function idsOf(event) {
  return [str(event.sessionKey), str(event.context?.sessionId)].filter(Boolean);
}

// Only the fields the tap reads; context.cfg holds the whole Gateway config and must never leave.
function payload(event) {
  const c = event.context ?? {};
  return {
    type: event.type,
    action: event.action,
    sessionKey: event.sessionKey,
    context: { sessionId: str(c.sessionId), workspaceDir: str(c.workspaceDir) ?? workspaceDir, content: str(c.content), success: c.success },
  };
}

function tap(event) {
  return new Promise((resolve) => {
    const child = execFile("meshpoint", ["tap", "openclaw"], { timeout: TIMEOUT_MS, maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err) {
        debug(\`tap failed: \${err.message}\`);
        return resolve({});
      }
      try {
        resolve(JSON.parse(stdout) ?? {});
      } catch {
        resolve({});
      }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(JSON.stringify(payload(event)));
  });
}

export default async function handler(event) {
  try {
    const key = \`\${event.type}:\${event.action}\`;
    const session = sessionOf(event);
    if (key === "agent:bootstrap") {
      workspaceDir = str(event.context?.workspaceDir) ?? workspaceDir;
      let cached = injects.get(session);
      if (!cached || Date.now() - cached.at > INJECT_TTL_MS) {
        cached = { text: str((await tap(event)).inject) ?? "", at: Date.now() };
        remember(injects, session, cached);
      }
      const nudge = idsOf(event).map((id) => nudges.get(id)).find(Boolean);
      for (const id of idsOf(event)) nudges.delete(id);
      const text = [cached.text, nudge].filter(Boolean).join("\\n\\n");
      if (text && workspaceDir && Array.isArray(event.context.bootstrapFiles)) {
        event.context.bootstrapFiles.push({ name: "MESHPOINT.md", path: \`\${workspaceDir}/MESHPOINT.md\`, content: text, missing: false });
      }
      return;
    }
    const out = await tap(event);
    if (key === "message:sent" && str(out.nudge)) for (const id of idsOf(event)) remember(nudges, id, out.nudge);
    if (key === "command:new" || key === "command:reset" || key === "session:auto-reset") {
      for (const id of idsOf(event)) {
        injects.delete(id);
        nudges.delete(id);
      }
    }
  } catch (err) {
    debug(\`handler failed: \${err instanceof Error ? err.message : String(err)}\`);
  }
}
`;

const PACKAGE_JSON = `${JSON.stringify(
  {
    name: PACK_NAME,
    version: "1.0.0",
    private: true,
    description: "Meshpoint team memory hook for OpenClaw",
    type: "module",
    openclaw: { hooks: ["."] },
  },
  null,
  2,
)}\n`;

export function packFiles(): Record<string, string> {
  return { "HOOK.md": HOOK_MD, "handler.js": HANDLER_JS, "package.json": PACKAGE_JSON };
}

export function writePack(dir: string): void {
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(packFiles())) writeFileSync(path.join(dir, name), content);
}
