// The checkpoint skill: the agent distills its own session into items. Installed next to the hooks
// so the Stop hook can ask for it by name.

export const SKILL_NAME = "meshpoint";

// Claude Code pre-approves the two commands through the skill; Codex does it with a rules file.
export function skillMarkdown(opts: { allowedTools: boolean }): string {
  return `---
name: ${SKILL_NAME}
description: Record what this session learned as Meshpoint team knowledge items. Use when a Meshpoint checkpoint is due, before ending a long session, or after a decision worth keeping.
${opts.allowedTools ? "allowed-tools: Bash(meshpoint items put:*), Bash(meshpoint items retract:*)\n" : ""}---
${SKILL_BODY}`;
}

const SKILL_BODY = `
# Meshpoint

Write the knowledge a teammate's agent would need to resume this work correctly, as items.

## Items

Each item is an object \`{"kind", "title", "body"}\`. \`kind\` is one of:

- \`decision\`: a choice made and why
- \`gotcha\`: something that bit or will bite
- \`convention\`: how things are done here
- \`fact\`: a stable truth about the code or environment
- \`status\`: where the work stands
- \`todo\`: an agreed next step

\`title\` is one line. \`body\` is one to three sentences, concrete: file names, commands, values, reasons.

## Rules

- Only what this session established. Never invent.
- Skip anything already listed under "Team knowledge" in the session-start context unless it changed; a changed decision or status gets a new item.
- An item that replaces an older one (a changed decision, a convention that moved, a todo now split differently) names the old id: add \`--supersedes <id>\` after the \`--item\`. The old item leaves recall and stays linked to the new one. A \`status\` item always replaces the branch's previous status on its own.
- Retract items that this session made wrong: a finished todo, a reversed decision with nothing in its place. The first column of "Team knowledge" is the item id.
- \`status\` and \`todo\` items leave recall on their own after 30 days without confirmation; the durable kinds stay until replaced or retracted.
- Items under "Possibly stale" name a file that is gone from this checkout. Check whether each still holds; retract it or write a corrected item. Do not leave them.
- Name files by their repo-relative path (\`src/auth/token.ts\`, not "the token file"). Meshpoint links the item to those files, checks them in later checkouts, and shows the item when someone edits them. The command warns about paths it cannot find.
- Prefer durable knowledge over moment-to-moment detail. Aim for 5 to 30 items; one \`status\` item at most.
- No secrets, tokens, or credentials.

## Procedure

Run \`meshpoint items put\` once, one \`--item kind title body\` per item, each optionally followed by \`--supersedes <id>\` (the item it replaces) or \`--key <slot>\` (a stable slot such as \`test-runner\`; a later item with the same key replaces this one). Single-quote title and body and keep the single quote character out of them (write "do not", not "don't"). No JSON, no heredoc.

\`\`\`bash
meshpoint items put \\
  --item decision 'Short title' 'What was chosen and why, with file names and values.' --supersedes 7d0e44aa \\
  --item convention 'Tests run with pnpm test' 'package.json scripts.test; CI runs the same.' --key test-runner \\
  --item gotcha 'Short title' 'What bit and how to avoid it.'
\`\`\`

Retract by id, several at once:

\`\`\`bash
meshpoint items retract 3f9c1a2b 7d0e44aa
\`\`\`

Then continue the work you were doing.
`;

export const SKILL_MD = skillMarkdown({ allowedTools: true });

// The import skill: seeds a branch with no memory from the repository's committed instruction
// files. Offered once per branch by the session-start inject.
export const IMPORT_SKILL_NAME = "meshpoint-import";

export function importSkillMarkdown(opts: { allowedTools: boolean }): string {
  return `---
name: ${IMPORT_SKILL_NAME}
description: Seed Meshpoint team knowledge for a branch that has none from the repository's committed instruction files (CLAUDE.md, AGENTS.md, Cursor rules, Copilot instructions). Use when the Meshpoint session-start context says the branch has no team knowledge yet.
${opts.allowedTools ? "allowed-tools: Bash(meshpoint items put:*), Bash(git ls-files:*)\n" : ""}---
${IMPORT_SKILL_BODY}`;
}

const IMPORT_SKILL_BODY = `
# Meshpoint import

Turn the repository's instruction files into Meshpoint items, once.

## Read

The session-start context lists the files. Read each one. They are committed files such as \`CLAUDE.md\`, \`AGENTS.md\`, \`.cursor/rules/*\`, \`.github/copilot-instructions.md\`.

## Select

Keep only statements about this repository that a teammate's agent needs:

- \`convention\`: how things are done here ("tests run with \`pnpm test\`", "migrations live in \`db/migrations\`").
- \`fact\`: a stable truth about the code or environment ("CI pins Node 22").
- \`gotcha\`: something that bites ("\`npm install\` fails without the private registry token").

Skip instructions aimed at the model rather than the repository ("be concise", "ask before refactoring"), prose that only introduces a section, and anything already true of every project. One item per rule. At most 30 items. Name files by their repo-relative path.

## Write

One command, one \`--item kind title body\` per item. Single quotes; no single quote character inside (write "do not", not "don't").

\`\`\`bash
meshpoint items put \\
  --item convention 'Tests run with pnpm test' 'package.json scripts.test runs vitest; CI runs the same command.' \\
  --item fact 'CI pins Node 22' '.github/workflows/ci.yml uses actions/setup-node with node-version 22.'
\`\`\`

Then continue the work you were doing. Do not run this skill again on this branch.
`;

export const IMPORT_SKILL_MD = importSkillMarkdown({ allowedTools: true });
