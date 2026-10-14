/**
 * Loads the GST portal's HSN/SAC directory into the shared reference database.
 *
 *   npm run db:hsn                          # the committed copy (a no-op if already loaded)
 *   npm run db:hsn -- <path to .xlsx>       # a newer download; on success it becomes the committed copy
 *   npm run db:hsn -- <path> --force        # past the "less than half" guard, deliberately
 *
 * The file is the portal's own: Services › User Services › Search HSN Code › "Download HSN Directory
 * in Excel Format" (https://tutorial.gst.gov.in/downloads/HSN_SAC.xlsx). A file only replaces the
 * committed copy after it has loaded cleanly, so the copy everybody else gets is the last good one.
 */
import "dotenv/config";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@deskzo/reference-client";
import { HSN_CANONICAL_FILE, loadHsnDirectory } from "./hsn";

const db = new PrismaClient({ datasourceUrl: process.env.REFERENCE_DATABASE_URL });
const args = process.argv.slice(2);
const force = args.includes("--force");
const given = args.find((a) => !a.startsWith("--"));

async function main() {
  const file = given ? path.resolve(given) : HSN_CANONICAL_FILE;
  if (!existsSync(file)) {
    console.error(`\nNo file at ${file}. Download the directory from the GST portal and pass its path.\n`);
    process.exit(1);
  }
  const result = await loadHsnDirectory(db, { bytes: readFileSync(file), sourceLabel: path.basename(file), force });
  if (result.status === "unchanged") {
    console.log(`\nAlready loaded — ${result.rows.toLocaleString("en-IN")} codes from this file.\n`);
    return;
  }
  console.log(
    `\nLoaded ${result.goods.toLocaleString("en-IN")} HSN and ${result.services.toLocaleString("en-IN")} SAC codes` +
      ` (${result.previous.toLocaleString("en-IN")} before; ${result.skipped} rows set aside).`,
  );
  if (given && path.resolve(given) !== HSN_CANONICAL_FILE) {
    copyFileSync(file, HSN_CANONICAL_FILE);
    console.log(`Kept as ${path.relative(process.cwd(), HSN_CANONICAL_FILE)} — commit it so every machine loads the same directory.`);
  }
  console.log("");
}

main()
  .catch((error) => {
    console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
