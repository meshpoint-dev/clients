import { describe, expect, it } from "vitest";
import { lastAssistantTurn, lastUserText, parseTranscript } from "../src/claude-code/transcript.js";

const line = (o: unknown) => JSON.stringify(o);
const jsonl = [
  line({ type: "user", message: { content: "fix the bug" } }),
  line({ type: "assistant", message: { content: [{ type: "text", text: "Looking." }, { type: "tool_use", input: { file_path: "/repo/src/a.ts" } }] } }),
  line({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } }),
  line({ type: "assistant", message: { content: [{ type: "tool_use", input: { file_path: "/repo/src/b.ts" } }] } }),
  line({ type: "assistant", message: { content: [{ type: "text", text: "Fixed in b.ts." }] } }),
  "not json",
  line({ type: "summary", summary: "ignored" }),
].join("\n");

describe("transcript", () => {
  it("keeps user prose, assistant text and touched paths; drops tool results and noise", () => {
    const entries = parseTranscript(jsonl);
    expect(entries.map((e) => e.role)).toEqual(["user", "assistant", "assistant", "assistant"]);
    expect(entries[1]).toEqual({ role: "assistant", text: "Looking.", paths: ["/repo/src/a.ts"], at: 0 });
  });

  it("joins the assistant reply since the last user prompt with deduplicated paths", () => {
    const turn = lastAssistantTurn(parseTranscript(jsonl));
    expect(turn).toEqual({ text: "Looking.\n\nFixed in b.ts.", paths: ["/repo/src/a.ts", "/repo/src/b.ts"] });
    expect(lastUserText(parseTranscript(jsonl))).toBe("fix the bug");
    expect(lastAssistantTurn([])).toBeNull();
  });
});
