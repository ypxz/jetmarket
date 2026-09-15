#!/usr/bin/env node
// Design-literal check (PLAN.md §6 / T8): apps/** must use design tokens +
// primitives from packages/ui, never raw colors or spacing literals.
//
// Flags in apps/**/*.{ts,tsx,js,jsx,css}:
//   1. Color literals: #hex, rgb()/hsl()/oklch() etc.
//   2. Tailwind palette utilities: bg-red-500, text-slate-900, border-blue-200…
//   3. Arbitrary spacing/size literals: p-[13px], mt-[7px], w-[321px], text-[18px]…
//      (values referencing tokens via var(--…)/theme()/calc(var(--…)) are fine)
//
// Exits 1 and lists every hit. Runs in the root `pnpm lint` chain and CI.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appsDir = path.join(root, 'apps');

const INCLUDE = /\.(ts|tsx|js|jsx|css)$/;
const ALLOWLIST = [
  /tokens?[^/]*\.css$/i,
  /globals?\.css$/i,
  /theme[^/]*\.css$/i,
  /\.(test|spec|stories)\.[jt]sx?$/i,
  /\.config\.[jt]s$/i,
  /\.d\.ts$/i,
];

const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch|oklab|hwb|lab|lch)\(/;
const PALETTE =
  /\b(?:bg|text|border|ring|fill|stroke|from|via|to|outline|decoration|divide|placeholder|caret|accent|shadow|border-[trblxyse])-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{1,3}\b/;
// spacing-ish tailwind props followed by an arbitrary […] value containing a
// number (unit or bare) after var()/theme() references are stripped.
const ARBITRARY =
  /\b(?:p[trblxyse]?|m[trblxyse]?|gap(?:-[xy])?|space-[xy]|w|h|min-w|min-h|max-w|max-h|size|inset(?:-[xy])?|top|right|bottom|left|translate-[xy]|scroll-[mp][trblxyse]?|rounded(?:-[trbl]{2})?|text|leading|tracking|columns|basis|indent)-\[([^\]]+)\]/;

function findFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!/node_modules|\.next|dist|coverage|out$/.test(entry.name)) out.push(...findFiles(p));
    } else if (INCLUDE.test(entry.name) && !ALLOWLIST.some((re) => re.test(entry.name))) {
      out.push(p);
    }
  }
  return out;
}

const findings = [];
for (const file of findFiles(appsDir)) {
  const rel = path.relative(root, file);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) return;
    const hits = [];
    if (COLOR_LITERAL.test(line)) hits.push('color literal');
    if (PALETTE.test(line)) hits.push('palette utility');
    let m;
    const arb = new RegExp(ARBITRARY.source, 'g');
    while ((m = arb.exec(line))) {
      const value = m[1].replace(/var\([^)]*\)|theme\([^)]*\)/g, '');
      if (/\d/.test(value)) hits.push(`arbitrary literal ${m[0].slice(0, 40)}`);
    }
    if (hits.length) findings.push(`${rel}:${i + 1}  ${hits.join('; ')}  →  ${trimmed.slice(0, 100)}`);
  });
}

if (findings.length) {
  console.error(`design-literal check: ${findings.length} violation(s) in apps/**`);
  console.error('use tokens from packages/ui (var(--…), semantic utilities like bg-surface) instead:\n');
  console.error(findings.join('\n'));
  process.exit(1);
}
console.log('design-literal check: clean (apps/** has no color/spacing literals)');
