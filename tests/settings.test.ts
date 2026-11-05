import { describe, expect, it } from "vitest";
import { installTapHooks, MANAGED_EVENTS, removeTapHooks, TAP_COMMAND } from "../src/claude-code/settings.js";

describe("claude code settings", () => {
  it("installs every managed event once, keeps user hooks, and removes cleanly", () => {
    const user = { type: "command" as const, command: "echo mine" };
    const base = { theme: "dark", hooks: { Stop: [{ hooks: [user] }], SessionStart: [{ hooks: [{ type: "command" as const, command: "meshpoint-tap claude-code" }] }] } };

    const installed = installTapHooks(installTapHooks(base));
    for (const { event, matcher } of MANAGED_EVENTS) {
      const groups = installed.hooks?.[event] ?? [];
      const managed = groups.flatMap((g) => g.hooks).filter((h) => h.command === TAP_COMMAND);
      expect(managed).toHaveLength(1);
      if (matcher) expect(groups.at(-1)?.matcher).toBe(matcher);
    }
    expect(installed.hooks?.Stop?.[0]?.hooks).toEqual([user]);
    expect(installed.hooks?.SessionStart?.flatMap((g) => g.hooks).map((h) => h.command)).toEqual([TAP_COMMAND]);
    expect(installed.theme).toBe("dark");

    const removed = removeTapHooks(installed);
    expect(removed.hooks).toEqual({ Stop: [{ hooks: [user] }] });
    expect(removeTapHooks({ hooks: { Stop: [{ hooks: [{ type: "command", command: TAP_COMMAND }] }] } })).toEqual({});
  });
});
