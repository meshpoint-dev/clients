// The checkpoint skill: the agent distills its own session into items. Installed next to the hooks
// so the Stop hook can ask for it by name.

export const SKILL_NAME = "meshpoint";

export const SKILL_MD = `---
name: ${SKILL_NAME}
description: Record what this session learned as Meshpoint team knowledge items. Use when a Meshpoint checkpoint is due, before ending a long session, or after a decision worth keeping.
allowed-tools: Bash(meshpoint items put:*)
---

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
- Prefer durable knowledge over moment-to-moment detail. Aim for 5 to 30 items; one \`status\` item at most.
- No secrets, tokens, or credentials.

## Procedure

Run \`meshpoint items put\` once, one \`--item kind title body\` per item. Single-quote title and body and keep the single quote character out of them (write "do not", not "don't"). No JSON, no heredoc.

\`\`\`bash
meshpoint items put \\
  --item decision 'Short title' 'What was chosen and why, with file names and values.' \\
  --item gotcha 'Short title' 'What bit and how to avoid it.'
\`\`\`

Then continue the work you were doing.
`;
