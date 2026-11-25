import type { Readable, Writable } from "node:stream";

// A stdio MCP server: JSON-RPC 2.0, one message per line. Only the lifecycle and the tools
// methods are implemented; everything else answers "method not found". No SDK: the protocol
// surface used here is five methods and fits in a file.

export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
const DEFAULT_PROTOCOL = PROTOCOL_VERSIONS[0];

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  // Returns the text content; a thrown error becomes an isError result with the message.
  run(args: Record<string, unknown>): Promise<string>;
}

export interface ServerOptions {
  name: string;
  version: string;
  instructions: string;
  tools: readonly ToolDef[];
}

interface Request {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL = -32603;

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export class McpServer {
  constructor(private readonly opts: ServerOptions) {}

  // One request in, one result or error out; null for notifications.
  async handle(req: Request): Promise<Record<string, unknown> | null> {
    const id = req.id ?? null;
    if (req.jsonrpc !== "2.0" || typeof req.method !== "string") return id === null ? null : error(id, INVALID_REQUEST, "invalid request");
    if (req.method.startsWith("notifications/")) return null;
    try {
      return { jsonrpc: "2.0", id, result: await this.dispatch(req.method, req.params ?? {}) };
    } catch (err) {
      if (err instanceof RpcError) return error(id, err.code, err.message);
      return error(id, INTERNAL, err instanceof Error ? err.message : String(err));
    }
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "initialize": {
        const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
        return {
          protocolVersion: (PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : DEFAULT_PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: this.opts.name, version: this.opts.version },
          instructions: this.opts.instructions,
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return { tools: this.opts.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
      case "tools/call": {
        const tool = this.opts.tools.find((t) => t.name === params.name);
        if (!tool) throw new RpcError(INVALID_PARAMS, `unknown tool: ${String(params.name)}`);
        const args = params.arguments;
        if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) throw new RpcError(INVALID_PARAMS, "arguments must be an object");
        try {
          return { content: [{ type: "text", text: await tool.run((args as Record<string, unknown>) ?? {}) }], isError: false };
        } catch (err) {
          return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
        }
      }
      default:
        throw new RpcError(METHOD_NOT_FOUND, `method not found: ${method}`);
    }
  }

  // Reads lines until the input ends; answers are written as they are ready.
  async serve(input: Readable, output: Writable): Promise<void> {
    let buffer = "";
    const pending: Promise<void>[] = [];
    const write = (msg: Record<string, unknown>) => {
      output.write(`${JSON.stringify(msg)}\n`);
    };
    const take = (line: string) => {
      const text = line.trim();
      if (!text) return;
      let req: Request;
      try {
        req = JSON.parse(text) as Request;
      } catch {
        write(error(null, PARSE_ERROR, "parse error"));
        return;
      }
      pending.push(
        this.handle(req).then((res) => {
          if (res) write(res);
        }),
      );
    };
    for await (const chunk of input) {
      buffer += typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        take(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
      }
    }
    take(buffer);
    await Promise.all(pending);
  }
}

function error(id: number | string | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
