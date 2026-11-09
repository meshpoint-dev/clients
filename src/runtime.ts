import { Checkpoints } from "./checkpoints.js";
import { loadConfig, repoContext, spoolDir, stateDir } from "./config.js";
import { freshConfig } from "./control.js";
import { Spool } from "./spool.js";
import { Tap } from "./tap.js";

// A Tap for one harness session, wired to the stored login and the on-disk spool. Null when the
// machine is not logged in or the directory is not a repo with an origin remote. In-process
// adapters (pi, opencode, openclaw) call this once per harness session.
export async function openTap(session: string, cwd: string): Promise<Tap | null> {
  const stored = loadConfig();
  if (!stored) return null;
  const repo = repoContext(cwd);
  if (!repo) return null;
  // A failed refresh keeps the stored token: the adapter must never break the harness.
  const config = await freshConfig(stored).catch(() => stored);
  return new Tap({
    config,
    repo,
    session,
    spool: new Spool(spoolDir()),
    checkpoints: new Checkpoints(stateDir()),
    refresh: () => freshConfig(config, { force: true }).catch(() => null),
  });
}
