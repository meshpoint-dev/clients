import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

// Refs are the repository paths an item depends on, read out of its own text. Only paths that
// exist in the checkout when the item is written count; the rest are reported so the agent can
// fix a typo. Verification later checks these same paths against other checkouts.
export const REFS_MAX = 50;

const KNOWN_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "json", "jsonc", "md", "mdx", "yml", "yaml", "toml", "ini", "cfg", "conf",
  "py", "rs", "go", "java", "kt", "kts", "rb", "php", "c", "h", "cc", "cpp", "hpp", "cs", "swift", "m", "mm", "scala", "ex", "exs",
  "sh", "bash", "zsh", "fish", "nix", "sql", "html", "css", "scss", "sass", "less", "vue", "svelte", "astro", "txt", "lock", "env",
  "xml", "proto", "graphql", "gql", "tf", "hcl", "tfvars", "dockerfile", "mk", "cmake", "gradle", "properties", "csv", "svg", "wasm",
]);
const TOKEN_RE = /[A-Za-z0-9_@~./-]+/g;
const BACKTICK_RE = /`([^`\n]+)`/g;
const STRIP_LEAD = /^[([{'"<]+/;
const STRIP_TRAIL = /[.,;:!?)\]}'">]+$/;
const VERSION_RE = /^v?\d+(\.\d+)+$/;
const DOMAIN_RE = /\.(com|dev|io|org|net|ai|app|sh|co|us|uk|de|fr|cloud|edu|gov)$/i;

export interface ExtractedRefs {
  // Repo-relative paths that exist in the checkout.
  refs: string[];
  // Path-like tokens that resolve to nothing; shown to the writer as warnings.
  missing: string[];
}

function clean(token: string): string {
  return token.replace(STRIP_LEAD, "").replace(STRIP_TRAIL, "");
}

// A token is path-like when it has a directory separator or a known file extension. URLs,
// flags, versions and bare domains are not.
export function looksLikePath(token: string): boolean {
  if (!token || token.length > 512) return false;
  if (token.includes("://") || token.startsWith("www.") || token.startsWith("-") || token.startsWith("@")) return false;
  if (VERSION_RE.test(token)) return false;
  if (token.includes("/")) return !token.split("/").some((seg) => seg === "..");
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return false;
  if (DOMAIN_RE.test(token)) return false;
  return KNOWN_EXTENSIONS.has(token.slice(dot + 1).toLowerCase());
}

// Resolves a token against the repo root; null when it leaves the root or does not exist.
function resolve(token: string, root: string, exists: (p: string) => boolean): string | null {
  const abs = path.isAbsolute(token) ? token : path.join(root, token.startsWith("~/") ? token.slice(2) : token);
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return exists(abs) ? rel.split(path.sep).join("/") : null;
}

export function extractRefs(text: string, root: string, exists: (p: string) => boolean = existsSync): ExtractedRefs {
  const refs = new Set<string>();
  const missing = new Set<string>();
  const consider = (raw: string, strict: boolean) => {
    const token = clean(raw);
    if (!token) return;
    const pathLike = looksLikePath(token);
    // Backticked tokens may be bare file names (Makefile); they count only when they exist.
    if (!pathLike && strict) return;
    // An absolute path outside the repository (/dev/null, /etc/hosts) is not a ref and not a miss.
    if (path.isAbsolute(token) && path.relative(root, token).startsWith("..")) return;
    const rel = resolve(token, root, exists);
    if (rel) refs.add(rel);
    else if (pathLike) missing.add(token);
  };
  for (const m of text.matchAll(BACKTICK_RE)) {
    const span = m[1] ?? "";
    if (!/\s/.test(span.trim())) consider(span.trim(), false);
    else for (const t of span.match(TOKEN_RE) ?? []) consider(t, true);
  }
  for (const t of text.replace(BACKTICK_RE, " ").match(TOKEN_RE) ?? []) consider(t, true);
  return { refs: [...refs].slice(0, REFS_MAX), missing: [...missing].slice(0, REFS_MAX) };
}

export function headSha(root: string): string {
  try {
    const out = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).toString().trim();
    return /^[0-9a-f]{40}$/.test(out) ? out : "";
  } catch {
    return "";
  }
}
