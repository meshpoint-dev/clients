import { describe, expect, it } from "vitest";
import { extractRefs, looksLikePath } from "../src/refs.js";

const existing = new Set(["/repo/src/auth.ts", "/repo/src/auth", "/repo/package.json", "/repo/Makefile", "/repo/docs/api.md", "/repo/.github/workflows/ci.yml"]);
const exists = (p: string) => existing.has(p);

describe("refs", () => {
  it("recognises paths by separator or known extension and rejects urls, flags, versions and domains", () => {
    expect(looksLikePath("src/auth.ts")).toBe(true);
    expect(looksLikePath("package.json")).toBe(true);
    expect(looksLikePath("Makefile")).toBe(false);
    expect(looksLikePath("https://meshpoint.dev/docs")).toBe(false);
    expect(looksLikePath("--project")).toBe(false);
    expect(looksLikePath("v1.0.2")).toBe(false);
    expect(looksLikePath("meshpoint.dev")).toBe(false);
    expect(looksLikePath("e.g")).toBe(false);
    expect(looksLikePath("../etc/passwd")).toBe(false);
    expect(looksLikePath("@meshpoint/sdk")).toBe(false);
  });

  it("keeps existing paths from prose and backticks, strips punctuation, reports path-like misses", () => {
    const text = "Tokens live in `src/auth.ts` (see package.json). CI is .github/workflows/ci.yml; docs/api.md too. Not src/gone.ts, and `Makefile` runs it. Read `cat src/auth.ts | less`.";
    expect(extractRefs(text, "/repo", exists)).toEqual({
      refs: ["src/auth.ts", "Makefile", "package.json", ".github/workflows/ci.yml", "docs/api.md"],
      missing: ["src/gone.ts"],
    });
  });

  it("maps absolute paths inside the root to relative ones and drops paths outside it", () => {
    expect(extractRefs("edit /repo/src/auth.ts and /etc/hosts and ~/package.json", "/repo", exists)).toEqual({ refs: ["src/auth.ts", "package.json"], missing: ["/etc/hosts"] });
    expect(extractRefs("directory src/auth holds it", "/repo", exists).refs).toEqual(["src/auth"]);
  });
});
