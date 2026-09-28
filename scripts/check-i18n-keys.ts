/**
 * `pnpm check:i18n` — CI gate: every literal `t("key")` call in apps/** must
 * resolve to a leaf in packages/i18n/messages/en.json (QA-192 caught a dead
 * `app.editListing.failed`). Dynamic keys (template strings) can't be checked
 * statically — they resolve against config-declared labelKeys and are covered
 * by the vertical configs' own compile.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SCAN_DIRS = ["apps"];
const EXT = new Set([".ts", ".tsx"]);
const MESSAGES = join(ROOT, "packages/i18n/messages/en.json");

const raw: unknown = JSON.parse(readFileSync(MESSAGES, "utf8"));
const leaves = new Set<string>();
(function walk(o: unknown, path: string) {
  if (o && typeof o === "object") {
    for (const [k, v] of Object.entries(o)) walk(v, `${path}${k}.`);
  } else {
    leaves.add(path.slice(0, -1));
  }
})(raw, "");

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (!["node_modules", ".next", "dist", "tmp"].includes(e)) yield* walk(p);
    } else if (EXT.has(p.slice(p.lastIndexOf(".")))) {
      yield p;
    }
  }
}

// const t = useTranslations("ns") | getTranslations("ns") |
//         useTranslations({ namespace: "ns" }) | useTranslations() (root).
// A non-literal first arg (template like `vertical.${ns}.home`) is dynamic —
// the binding is recorded as unverifiable and its calls are skipped, never
// checked against the root namespace.
const BIND =
  /(?:const|let)\s+(\w+)\s*=\s*(?:await\s+)?(?:use|get)Translations\(\s*("[^"]*"|\{[^}]*namespace:\s*"[^"]+"[^}]*\}|\))/g;
const CALL = (v: string) => new RegExp(`\\b${v}\\(\\s*"([^"]+)"`, "g");

const bad: string[] = [];
let checked = 0;
for (const dir of SCAN_DIRS) {
  for (const file of walk(join(ROOT, dir))) {
    const src = readFileSync(file, "utf8");
    const bindings = new Map<string, string>();
    for (const m of src.matchAll(BIND)) {
      const arg = m[2]!;
      const ns =
        arg === ")"
          ? ""
          : arg.startsWith('"')
            ? arg.slice(1, -1)
            : (arg.match(/namespace:\s*"([^"]+)"/)?.[1] ?? "");
      bindings.set(m[1]!, ns);
    }
    if (!bindings.size) continue;
    for (const [v, ns] of bindings) {
      for (const km of src.matchAll(CALL(v))) {
        const key = ns ? `${ns}.${km[1]}` : km[1]!;
        checked++;
        if (!leaves.has(key)) {
          bad.push(`${file.replace(`${ROOT}/`, "")}: ${v}("${km[1]}") -> ${key}`);
        }
      }
    }
  }
}

if (bad.length) {
  console.error(`check:i18n — ${bad.length} missing key(s):`);
  for (const b of bad) console.error(`  ${b}`);
  process.exit(1);
}
console.log(`check:i18n ok — ${checked} literal keys resolve`);
