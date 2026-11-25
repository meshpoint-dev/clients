import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// Registers the stdio server where MCP clients look. One file is written: <repo>/.mcp.json, which
// Claude Code (project scope) and VS Code with Copilot both read. Other clients keep their own
// user-level files; connect prints the entry for them instead of guessing at those files.

export const MCP_FILE = ".mcp.json";
export const MCP_ENTRY = { type: "stdio", command: "meshpoint", args: ["mcp"] } as const;

export interface McpFile {
  readonly mcpServers?: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

export function installMcpEntry(file: McpFile): McpFile {
  return { ...file, mcpServers: { ...file.mcpServers, meshpoint: MCP_ENTRY } };
}

export function removeMcpEntry(file: McpFile): McpFile {
  const { meshpoint: _dropped, ...servers } = file.mcpServers ?? {};
  const { mcpServers: _old, ...rest } = file;
  return Object.keys(servers).length > 0 ? { ...rest, mcpServers: servers } : rest;
}

export function mcpSnippets(home = homedir(), platform: NodeJS.Platform = process.platform): string {
  const entry = JSON.stringify({ mcpServers: { meshpoint: MCP_ENTRY } }, null, 2);
  const desktop = platform === "darwin" ? path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json") : platform === "win32" ? "%APPDATA%\\Claude\\claude_desktop_config.json" : path.join(home, ".config", "Claude", "claude_desktop_config.json");
  return [
    "Add the Meshpoint MCP server to a client by hand:",
    "",
    `  Claude Code, VS Code with Copilot (one repository):   meshpoint connect mcp --project <repo>   writes <repo>/${MCP_FILE}`,
    `  Claude Code (every repository):                        claude mcp add --scope user meshpoint -- meshpoint mcp`,
    `  VS Code with Copilot (every repository):               ${path.join(home, ".copilot", "mcp-config.json")}`,
    `  Claude Desktop:                                        ${desktop}`,
    `  Zed:                                                   settings.json, key "context_servers": {"meshpoint": {"command": "meshpoint", "args": ["mcp"]}}`,
    "",
    "The entry for the mcpServers files:",
    "",
    entry.replace(/^/gm, "  "),
    "",
    "The server finds the repository from its working directory; clients that start it elsewhere pass --cwd <repo> in args.",
  ].join("\n");
}

export function connectMcp(opts: { remove: boolean; projectDir?: string }): string {
  if (!opts.projectDir) {
    if (opts.remove) return "connect mcp --remove needs --project <repo>; user-level entries were added by hand and are removed the same way";
    return mcpSnippets();
  }
  const file = path.join(opts.projectDir, MCP_FILE);
  let current: McpFile = {};
  try {
    current = JSON.parse(readFileSync(file, "utf8")) as McpFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`could not read ${file}: ${(err as Error).message}`);
  }
  if (opts.remove) {
    const next = removeMcpEntry(current);
    if (Object.keys(next).length > 0) writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
    else rmSync(file, { force: true });
    return `removed the meshpoint server from ${file}`;
  }
  writeFileSync(file, `${JSON.stringify(installMcpEntry(current), null, 2)}\n`);
  return `registered the meshpoint MCP server in ${file} (Claude Code project scope, VS Code with Copilot). Commit it so the team gets it; Claude Code asks once to approve a project server.`;
}
