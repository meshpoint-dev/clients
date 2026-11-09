// The opencode plugin entry. opencode calls every export of a plugin file as a plugin, so this
// module exports the plugin function and nothing else; the hook mapping lives in hooks.ts.
import { openTap } from "../runtime.js";
import { createOpencodeHooks, type OpencodeClient, type OpencodeHooks } from "./hooks.js";

export const MeshpointPlugin = async (input: { client: OpencodeClient; directory: string }): Promise<OpencodeHooks> =>
  createOpencodeHooks({ client: input.client, directory: input.directory, openTap });
