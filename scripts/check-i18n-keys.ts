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
const MESSAGES_DIR = join(ROOT, "packages/i18n/messages");
const MESSAGES = join(MESSAGES_DIR, "en.json");

// Every catalog's leaf-key set must match en's, leaf-for-leaf — a dropped
// or renamed key otherwise becomes a runtime i18n hole (QA-492). Arrays
// are leaves too: their items are addressable by index, so a length/key
// mismatch counts as a leaf diff.
function leafKeys(o: unknown, path = ""): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (x: unknown, p: string) => {
    if (x && typeof x === "object") {
      const entries = Array.isArray(x) ? x.entries() : Object.entries(x);
      for (const [k, v] of entries as Iterable<[string | number, unknown]>) {
        walk(v, `${p}${k}.`);
      }
    } else {
      out.set(p.slice(0, -1), String(x));
    }
  };
  walk(o, path);
  return out;
}
const enLeaves = leafKeys(JSON.parse(readFileSync(MESSAGES, "utf8")));
const leaves = new Set(enLeaves.keys());

// ICU placeholders {name} / {a,b,plural} args must line up across locales —
// a translator that drops `{count}` or renames `{date}` silently renders a
// raw `{…}` at runtime. Rough check: compare the set of identifier heads.
function placeholders(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\{\s*([A-Za-z0-9_]+)\s*[,}]/g)) {
    out.add(m[1]!);
  }
  return out;
}
const catalogBad: string[] = [];
for (const f of readdirSync(MESSAGES_DIR)) {
  if (!f.endsWith(".json") || f === "en.json") continue;
  const other = leafKeys(
    JSON.parse(readFileSync(join(MESSAGES_DIR, f), "utf8")),
  );
  for (const k of enLeaves.keys()) {
    if (!other.has(k)) catalogBad.push(`${f}: missing ${k}`);
  }
  for (const k of other.keys()) {
    if (!enLeaves.has(k)) catalogBad.push(`${f}: extra ${k}`);
  }
  for (const [k, v] of enLeaves) {
    const ov = other.get(k);
    if (ov === undefined) continue;
    if (ov.trim() === "") catalogBad.push(`${f}: empty value ${k}`);
    const a = [...placeholders(v)].sort().join(",");
    const b = [...placeholders(ov)].sort().join(",");
    if (a !== b) {
      catalogBad.push(`${f}: ${k} placeholders differ — en {${a}} vs {${b}}`);
    }
  }
}
if (catalogBad.length) {
  console.error(`check:i18n — ${catalogBad.length} catalog parity issue(s):`);
  for (const b of catalogBad.slice(0, 40)) console.error(`  ${b}`);
  if (catalogBad.length > 40) {
    console.error(`  … and ${catalogBad.length - 40} more`);
  }
  process.exit(1);
}

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
