import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Fails if anything opens an off-site URL without stripping the referrer.
 *
 * The rule is easy to state and easy to forget: a link out of the ERP must not tell the far end
 * which record was open when somebody clicked it. `OutboundLink` does that for every link, so this
 * check exists to catch the case where a raw `<a target="_blank">` creeps back in — which is the
 * only way the guarantee can quietly stop holding.
 */

const ROOT = new URL("../src", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (/\.tsx?$/.test(entry)) yield path;
  }
}

const ALLOWED = [
  "src/components/ui/outbound-link.tsx",
  // Not an anchor: the `<base target="_blank">` of the document the mail log shows an email in. That
  // document sits in a frame sandboxed with nothing allowed, so no link in it can open at all — the
  // base target exists to make sure of that — and it carries `no-referrer` besides. See mailPreviewDocument.
  "src/lib/mail-log.ts",
];
const problems = [];

for (const file of walk(ROOT)) {
  const rel = file.replaceAll("\\", "/").slice(file.replaceAll("\\", "/").indexOf("src/"));
  if (ALLOWED.includes(rel)) continue;
  const lines = readFileSync(file, "utf8").split("\n");

  lines.forEach((line, i) => {
    // An external href written by hand rather than through the component.
    if (/href=\{?["`]https?:\/\//.test(line) || /href=\{`https?:\/\//.test(line)) {
      problems.push(`${rel}:${i + 1}  external href — use <OutboundLink>`);
    }
    // A new tab opened from a raw anchor. Same-origin paths are fine; anything else is not.
    if (/target="_blank"/.test(line)) {
      const window = lines.slice(Math.max(0, i - 6), i + 6).join(" ");
      const internal = /href=\{`\/|href="\//.test(window);
      if (!internal) problems.push(`${rel}:${i + 1}  target="_blank" on a raw anchor — use <OutboundLink>`);
    }
    // An image fetched from another host leaks the referrer exactly as a link does.
    if (/<img/.test(line)) {
      const window = lines.slice(i, i + 10).join(" ");
      if (/src=\{?[`"]?https?:\/\//.test(window) && !/referrerPolicy/.test(window)) {
        problems.push(`${rel}:${i + 1}  third-party <img> without referrerPolicy="no-referrer"`);
      }
    }
  });
}

if (problems.length > 0) {
  console.error("Outbound links that would leak a referrer:\n");
  for (const p of problems) console.error("  " + p);
  console.error(`\n${problems.length} problem(s).`);
  process.exit(1);
}

console.log("Outbound links: every off-site link and image strips its referrer.");
