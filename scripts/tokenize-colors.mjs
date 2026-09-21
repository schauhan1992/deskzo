/**
 * One-off codemod: replace hard-coded palette classes with the semantic design tokens defined in
 * globals.css, so every screen follows the brand colour and works in dark mode.
 *
 *   node scripts/tokenize-colors.mjs
 *
 * Ordered — the paired rules must run before the single-class ones they contain.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const REPLACEMENTS = [
  // Paired first: the old "primary" look becomes the brand colour.
  [/bg-slate-900 text-white/g, "bg-brand text-brand-contrast"],
  [/bg-slate-900\/(\d+)/g, "bg-brand/$1"],

  // Surfaces
  [/bg-white\b/g, "bg-surface"],
  [/bg-slate-50\b/g, "bg-surface-sunken"],
  [/bg-slate-100\b/g, "bg-surface-sunken"],
  [/bg-slate-200\b/g, "bg-line"],
  [/bg-slate-300\b/g, "bg-line-strong"],
  [/bg-slate-700\b/g, "bg-brand"],
  [/bg-slate-900\b/g, "bg-brand"],

  // Text
  [/text-slate-900\b/g, "text-text"],
  [/text-slate-800\b/g, "text-text"],
  [/text-slate-700\b/g, "text-text"],
  [/text-slate-600\b/g, "text-muted"],
  [/text-slate-500\b/g, "text-muted"],
  [/text-slate-400\b/g, "text-subtle"],
  [/text-slate-300\b/g, "text-subtle"],

  // Lines
  [/border-slate-50\b/g, "border-line"],
  [/border-slate-100\b/g, "border-line"],
  [/border-slate-200\b/g, "border-line"],
  [/border-slate-300\b/g, "border-line-strong"],
  [/border-slate-400\b/g, "border-line-strong"],
  [/border-slate-900\b/g, "border-brand"],
  [/divide-slate-100\b/g, "divide-line"],
  [/divide-slate-200\b/g, "divide-line"],
  [/ring-slate-900\/(\d+)/g, "ring-brand"],

  // Status colours -> semantic tokens so they stay readable on a dark surface.
  [/text-red-(?:600|700|800|900)\b/g, "text-danger"],
  [/bg-red-50\b/g, "bg-danger-bg"],
  [/bg-red-100\b/g, "bg-danger-bg"],
  [/border-red-(?:200|300)\b/g, "border-danger"],
  [/hover:bg-red-50\b/g, "hover:bg-danger-bg"],
  [/hover:text-red-700\b/g, "hover:text-danger"],

  [/text-emerald-(?:600|700|800|900)\b/g, "text-success"],
  [/bg-emerald-50\b/g, "bg-success-bg"],
  [/bg-emerald-100\b/g, "bg-success-bg"],
  [/border-emerald-(?:200|300)\b/g, "border-success"],

  [/text-amber-(?:600|700|800|900)\b/g, "text-warning"],
  [/bg-amber-50\b/g, "bg-warning-bg"],
  [/bg-amber-100\b/g, "bg-warning-bg"],
  [/border-amber-(?:200|300)\b/g, "border-warning"],

  [/text-blue-(?:600|700|800|900)\b/g, "text-info"],
  [/bg-blue-50(?:\/\d+)?\b/g, "bg-info-bg"],
  [/bg-blue-100\b/g, "bg-info-bg"],
  [/border-blue-(?:100|200|300)\b/g, "border-info"],
];

const SKIP = new Set(["node_modules", ".next", ".git"]);
const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.tsx$/.test(full)) files.push(full);
  }
})("src");

let changedFiles = 0;
let totalEdits = 0;
for (const file of files) {
  const original = readFileSync(file, "utf8");
  let next = original;
  for (const [pattern, replacement] of REPLACEMENTS) {
    next = next.replace(pattern, (...args) => {
      totalEdits++;
      return typeof replacement === "string" ? replacement.replace("$1", args[1] ?? "") : replacement;
    });
  }
  if (next !== original) {
    writeFileSync(file, next);
    changedFiles++;
  }
}
console.log(`${totalEdits} class replacements across ${changedFiles} files`);
