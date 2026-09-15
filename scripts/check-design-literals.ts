/**
 * `pnpm check:design` — CI gate: no color/spacing literals in apps/** code.
 * Catches hex colors, arbitrary Tailwind values ([#fff], [13px], [2.5rem]),
 * and raw palette utilities (bg-red-500 etc.) — app code must use tokens.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SCAN_DIRS = ["apps"];
const EXT = new Set([".ts", ".tsx", ".css"]);

// Tailwind scale utilities (p-4, gap-6, mt-1) ARE the token system — allowed.
// What's banned: raw hex/rgb colors, arbitrary-value escapes, palette colors.
const patterns: { re: RegExp; label: string }[] = [
  { re: /#[0-9a-fA-F]{3,8}\b/, label: "hex color" },
  { re: /\[(?:#[0-9a-fA-F]{3,8}|rgb|hsl|oklch|[0-9.]+(?:px|rem|em|vh|vw))/, label: "arbitrary tw value" },
  { re: /\b(?:bg|text|border|ring|from|to|via|fill|stroke)-(?:red|orange|amber|yellow|green|teal|cyan|blue|indigo|violet|purple|pink|rose|slate|gray|zinc|neutral|stone|emerald|lime|fuchsia|sky)-\d{2,3}\b/, label: "palette literal" },
];

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

let violations = 0;
for (const dir of SCAN_DIRS) {
  let files: string[] = [];
  try {
    files = [...walk(join(ROOT, dir))];
  } catch {
    continue;
  }
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const { re, label } of patterns) {
        if (re.test(line) && !line.includes("check-design-literals") && !line.includes("// design-ok")) {
          console.error(`${file}:${i + 1}  ${label}  ${line.trim().slice(0, 100)}`);
          violations++;
        }
      }
    });
  }
}

if (violations > 0) {
  console.error(`\n${violations} design literal(s) in apps/** — use tokens/primitives (see packages/ui/tokens.css)`);
  process.exit(1);
}
console.log("check:design ok — no literals in apps/**");
