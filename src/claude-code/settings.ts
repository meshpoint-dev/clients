// Idempotent hook installation for Claude Code's settings.json. Every managed entry shells to the
// meshpoint tap, so re-running connect upgrades in place and never touches hooks the user wrote.

export const TAP_COMMAND = "meshpoint tap claude-code";
const HOOK_TIMEOUT_S = 30;

interface HookCommand {
  readonly type: "command";
  readonly command: string;
  readonly timeout?: number;
  readonly [key: string]: unknown;
}

interface HookGroup {
  readonly matcher?: string;
  readonly hooks: readonly HookCommand[];
}

export interface ClaudeCodeSettings {
  readonly hooks?: Readonly<Record<string, readonly HookGroup[]>>;
  readonly [key: string]: unknown;
}

export interface ManagedEvent {
  readonly event: string;
  readonly matcher?: string;
  // Seconds the harness waits for the hook; the default suits network calls, edits get a short one.
  readonly timeout?: number;
}

export const EDIT_TOOLS_MATCHER = "Edit|Write|MultiEdit|NotebookEdit";
const EDIT_HOOK_TIMEOUT_S = 5;

// SessionStart includes "compact": the items are what survives a context loss. PreToolUse on the
// editing tools carries the file-level notice (items naming the file, teammates on it).
export const MANAGED_EVENTS: readonly ManagedEvent[] = [
  { event: "SessionStart", matcher: "startup|resume|clear|compact" },
  { event: "UserPromptSubmit" },
  { event: "PreToolUse", matcher: EDIT_TOOLS_MATCHER, timeout: EDIT_HOOK_TIMEOUT_S },
  { event: "Stop" },
  { event: "PreCompact" },
  { event: "SessionEnd" },
];

export interface TapHookSpec {
  readonly command: string;
  readonly events: readonly ManagedEvent[];
  // Extra handler fields, such as Codex's additionalContextLimit.
  readonly extra?: Readonly<Record<string, unknown>>;
}

const CLAUDE_CODE_SPEC: TapHookSpec = { command: TAP_COMMAND, events: MANAGED_EVENTS };

function isManaged(hook: HookCommand): boolean {
  return hook.command.startsWith("meshpoint tap ") || hook.command.startsWith("meshpoint-tap ");
}

function withoutManaged(groups: readonly HookGroup[] | undefined): HookGroup[] {
  return (groups ?? [])
    .map((group) => ({ ...group, hooks: group.hooks.filter((hook) => !isManaged(hook)) }))
    .filter((group) => group.hooks.length > 0);
}

export function installTapHooks(settings: ClaudeCodeSettings, spec: TapHookSpec = CLAUDE_CODE_SPEC): ClaudeCodeSettings {
  const hooks: Record<string, readonly HookGroup[]> = { ...settings.hooks };
  for (const { event, matcher, timeout } of spec.events) {
    hooks[event] = [
      ...withoutManaged(hooks[event]),
      { ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: "command", command: spec.command, timeout: timeout ?? HOOK_TIMEOUT_S, ...spec.extra }] },
    ];
  }
  return { ...settings, hooks };
}

export function removeTapHooks(settings: ClaudeCodeSettings): ClaudeCodeSettings {
  if (settings.hooks === undefined) return settings;
  const hooks: Record<string, readonly HookGroup[]> = {};
  for (const [event, groups] of Object.entries(settings.hooks)) {
    const kept = withoutManaged(groups);
    if (kept.length > 0) hooks[event] = kept;
  }
  const next: { hooks?: unknown; [key: string]: unknown } = { ...settings, hooks };
  if (Object.keys(hooks).length === 0) delete next.hooks;
  return next as ClaudeCodeSettings;
}
