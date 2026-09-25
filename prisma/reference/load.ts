/**
 * Loads the PIN directory, and keeps the file it came from.
 *
 *   npm run db:reference                       # load the committed copy (a no-op if already loaded)
 *   npm run db:reference -- <path to .csv>     # load a newly downloaded file and commit-ready copy it
 *   npm run db:reference -- <path> --force     # past the "less than half" guard, deliberately
 *   npm run db:reference:download              # fetch it from the data.gov.in API instead (needs
 *                                              #   DATA_GOV_IN_API_KEY in .env), then load it
 *
 * With no path and no committed copy, any single `.csv` dropped into `prisma/reference/` is used —
 * so "save the download into that folder and run the command" is the whole procedure.
 *
 * A file only becomes the committed copy *after* it has loaded cleanly. A wrong or truncated file
 * fails the load, and the copy everybody else will get stays the last good one.
 */
import "dotenv/config";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { CANONICAL_FILE, loadPincodes, saveCanonicalCopy } from "./pincodes";
import { fetchDirectory } from "./fetch";

const db = new PrismaClient();
const args = process.argv.slice(2);
const force = args.includes("--force");
const fromApi = args.includes("--from-api");
const given = args.find((a) => !a.startsWith("--"));

function pickFile(): string | null {
  if (given) return path.resolve(given);
  if (existsSync(CANONICAL_FILE)) return CANONICAL_FILE;
  const dropped = readdirSync(__dirname).filter((f) => f.toLowerCase().endsWith(".csv"));
  if (dropped.length === 1) return path.join(__dirname, dropped[0]!);
  if (dropped.length > 1) {
    console.error(`\nMore than one .csv in prisma/reference/ (${dropped.join(", ")}) — pass the one to load.\n`);
    process.exit(1);
  }
  return null;
}

/**
 * Fetches the directory into a scratch CSV beside this file, for the ordinary load path to take over.
 *
 * Written to disk rather than loaded from memory so that everything after this point is exactly what
 * happens to a downloaded file: the same checks, the same refusal of a short file, and the same
 * compressed copy saved for committing. The scratch file is git-ignored and removed afterwards.
 */
async function download(): Promise<string> {
  const apiKey = process.env.DATA_GOV_IN_API_KEY ?? "";
  if (!apiKey.trim()) {
    console.error(
      [
        "",
        "No API key. Add this line to .env (git ignores that file), with your key from data.gov.in:",
        "",
        "  DATA_GOV_IN_API_KEY=your-key-here",
        "",
        "then run  npm run db:reference:download  again.",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }
  console.log("\nFetching the PIN directory from data.gov.in (Department of Posts)\n");
  const { csv, rows } = await fetchDirectory({ apiKey, log: console.log });
  const scratch = SCRATCH;
  writeFileSync(scratch, csv);
  console.log(`  fetched ${rows.toLocaleString("en-IN")} post offices`);
  return scratch;
}

async function main() {
  const downloaded = fromApi ? await download() : null;
  const file = downloaded ?? pickFile();
  if (!file) {
    console.error(
      [
        "",
        "No PIN directory to load.",
        "",
        "  1. Open data.gov.in and search for “All India Pincode Directory till last month”",
        "     (published by the Department of Posts, updated monthly).",
        "  2. Download it as CSV and save it into prisma/reference/.",
        "  3. Run  npm run db:reference  again.",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }
  if (!existsSync(file)) {
    console.error(`\nNo such file: ${file}\n`);
    process.exit(1);
  }

  console.log(`\nLoading ${path.relative(process.cwd(), file)}${force ? " (forced)" : ""}\n`);
  const result = await loadPincodes(db, { file, force, log: console.log, ...(fromApi ? { sourceLabel: "data.gov.in API" } : {}) });

  if (result.status === "unchanged") {
    console.log(`  Already loaded — ${result.rows.toLocaleString("en-IN")} post offices, same file. Nothing to do.\n`);
    return;
  }

  console.log(`  Loaded ${result.rows.toLocaleString("en-IN")} post offices across ${result.pincodes.toLocaleString("en-IN")} PINs`);
  const skipped = Object.entries(result.skipped).filter(([, n]) => n > 0);
  if (skipped.length) console.log(`  Set aside: ${skipped.map(([why, n]) => `${n} ${why}`).join(", ")}`);

  const unresolved = Object.entries(result.unresolvedStates).sort((a, b) => b[1] - a[1]);
  if (unresolved.length) {
    // Loaded anyway — the PINs are real — but these will not fill a state in, and each one is a
    // spelling `stateCodeFromName` should learn.
    console.log("\n  These state names did not resolve to a GST code, so their PINs will not fill the state in:");
    for (const [name, n] of unresolved) console.log(`    "${name}" — ${n.toLocaleString("en-IN")} offices`);
    console.log("  Add each as an alias in STATE_ALIASES (src/lib/gst-engine.ts) and reload with --force.");
  } else {
    console.log("  Every state resolved to a GST code.");
  }

  if (path.resolve(file) !== CANONICAL_FILE) {
    const size = saveCanonicalCopy(file);
    console.log(
      `\n  Saved as prisma/reference/india-post-pincodes.csv.gz (${(size / 1024 / 1024).toFixed(1)} MB) — ` +
        "commit it, and every other machine and every migrate reset gets this directory.",
    );
    if (!fromApi && path.dirname(path.resolve(file)) === __dirname) {
      console.log(`  ${path.basename(file)} can be deleted now; git ignores it either way.`);
    }
  }
  console.log("");
}

const SCRATCH = path.join(__dirname, "india-post-pincodes.download.csv");

main()
  .catch((error) => {
    console.error(`\n${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    // Always, success or not: left behind, it is a lone .csv in this folder, which a plain
    // `npm run db:reference` would pick up and load as if somebody had put it there on purpose.
    rmSync(SCRATCH, { force: true });
    return db.$disconnect();
  });
