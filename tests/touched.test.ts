import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Touched, TOUCHED_CAP } from "../src/touched.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "mp-touched-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("touched paths", () => {
  it("dedupes by path with the newest time, answers since a cutoff, caps and clears", () => {
    const t = new Touched(dir);
    t.append("p", "master", ["a.ts", "b.ts"], 10);
    t.append("p", "master", ["a.ts"], 30);
    t.append("p", "feature", ["c.ts"], 30);
    expect(t.since("p", "master", 0)).toEqual(["b.ts", "a.ts"]);
    expect(t.since("p", "master", 10)).toEqual(["a.ts"]);
    expect(t.since("p", "feature", 0)).toEqual(["c.ts"]);
    t.append("p", "master", Array.from({ length: TOUCHED_CAP + 5 }, (_, i) => `f${i}.ts`), 40);
    expect(t.since("p", "master", 0)).toHaveLength(TOUCHED_CAP);
    t.clear("p", "master");
    expect(t.since("p", "master", 0)).toEqual([]);
    expect(t.since("p", "feature", 0)).toEqual(["c.ts"]);
  });
});
