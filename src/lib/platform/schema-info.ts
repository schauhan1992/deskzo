import { readdirSync } from "node:fs";
import path from "node:path";

/**
 * How far behind a workspace's schema is: the workspace migrations this code carries, and how many
 * of them come after the one a workspace is at. Read from the folder names, the same way
 * `latestMigrationName` does (src/lib/platform/migrate.ts) — the path is spelled out so the build
 * traces the one folder instead of the whole project.
 *
 * Nothing is cached (a module-level cache would be state shared by every workspace): a loader that
 * needs it for many rows reads the names once and passes them to `behindBy`.
 */

/** The workspace migrations' folder names, oldest first. Empty when the folder cannot be read. */
export function workspaceMigrationNames(): string[] {
  try {
    return readdirSync(path.join(process.cwd(), "prisma", "migrations"), { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d{14}_/.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** How many migrations come after `version`: 0 when it is the latest; null when there is none, or it is not one this code knows. */
export function behindBy(version: string | null, names: string[] = workspaceMigrationNames()): number | null {
  if (!version) return null;
  const at = names.indexOf(version);
  return at < 0 ? null : names.length - 1 - at;
}
