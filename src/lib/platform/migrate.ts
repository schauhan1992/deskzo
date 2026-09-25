import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";

/**
 * Running Prisma's migrations against one database — a new workspace's, a warm one, a restored one,
 * every workspace's in turn (scripts/tenants-migrate.ts). Through the project's own Prisma CLI, with
 * the database named in the child's environment only: never a shell, never an argument.
 */

export type Schema = "workspace" | "reference" | "control";

const CONFIG: Record<Schema, { config: string | null; env: string }> = {
  workspace: { config: null, env: "DATABASE_URL" },
  reference: { config: "prisma.reference.config.ts", env: "REFERENCE_DATABASE_URL" },
  control: { config: "prisma.control.config.ts", env: "CONTROL_DATABASE_URL" },
};

/**
 * Each schema's migrations folder, spelled out rather than built from a variable: the build traces
 * the files a server bundle reads, and a folder it cannot work out makes it trace the whole project.
 */
function migrationsFolder(schema: Schema): string {
  if (schema === "reference") return path.join(process.cwd(), "prisma", "reference", "migrations");
  if (schema === "control") return path.join(process.cwd(), "prisma", "control", "migrations");
  return path.join(process.cwd(), "prisma", "migrations");
}

/** The newest migration this code carries for a schema — what a database is current at. */
export function latestMigrationName(schema: Schema = "workspace"): string | null {
  const names = readdirSync(migrationsFolder(schema), { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d{14}_/.test(e.name))
    .map((e) => e.name)
    .sort();
  return names.at(-1) ?? null;
}

/** `prisma migrate deploy` against `databaseUrl`. Resolves with Prisma's output; rejects with its tail. */
export function migrateDeploy(databaseUrl: string, schema: Schema = "workspace"): Promise<string> {
  const { config, env } = CONFIG[schema];
  const cli = path.join(process.cwd(), "node_modules", "prisma", "build", "index.js");
  const args = [cli, "migrate", "deploy", ...(config ? ["--config", config] : [])];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { shell: false, cwd: process.cwd(), env: { ...process.env, [env]: databaseUrl } });
    let output = "";
    child.stdout?.on("data", (c) => (output += String(c)));
    child.stderr?.on("data", (c) => (output += String(c)));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(output) : reject(new Error(output.trim().split("\n").slice(-6).join("\n") || `prisma migrate deploy exited ${code}`))));
  });
}
