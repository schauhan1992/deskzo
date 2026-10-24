import { spawn } from "node:child_process";
import path from "node:path";
import type { DumpTool } from "@/lib/backup/run";

/**
 * Running pg_restore — for a workspace's restore (scripts/restore-worker.ts) and the off-site restore
 * drill (src/lib/offsite/drill.ts), which must restore exactly the way a real restore would or it
 * proves nothing.
 */

/**
 * Puts the dump where the tool can seek in it.
 *
 * A custom-format archive has a table of contents that pg_restore seeks around; handed it on a pipe
 * it closes the input instead. On the host that means passing the path; through a container it
 * means copying the file in first, because the host's filesystem is not visible from inside.
 */
export async function stageForTool(tool: DumpTool, file: string): Promise<{ pathForTool: string; cleanup: () => Promise<void> }> {
  if (!tool.inContainer) return { pathForTool: file, cleanup: async () => {} };

  const service = process.env.BACKUP_DB_SERVICE?.trim() || "postgres";
  const inside = `/tmp/deskzo-restore-${path.basename(file)}`;
  await run("docker", ["compose", "cp", file, `${service}:${inside}`]);

  return {
    pathForTool: inside,
    cleanup: async () => {
      await run("docker", ["compose", "exec", "-T", service, "rm", "-f", inside]).catch(() => {});
    },
  };
}

export function runRestore(
  tool: DumpTool,
  fileForTool: string,
  connection: { host: string; port: string; user: string; password: string; database: string },
): Promise<void> {
  const connectionArgs = tool.inContainer ? [] : ["--host", connection.host, "--port", connection.port];
  const args = [
    ...tool.args,
    "--no-owner",
    "--no-privileges",
    ...connectionArgs,
    `--username=${connection.user}`,
    `--dbname=${connection.database}`,
    fileForTool,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(tool.command, args, {
      env: { ...process.env, PGPASSWORD: connection.password },
      shell: false,
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      /**
       * Non-zero is a failure, and the stderr goes with it.
       *
       * pg_restore writes warnings on a clean run too, so stderr alone says nothing — it is the
       * exit code that decides, exactly as `npm run db:restore` decides it. The text is carried
       * into the status file regardless, because "pg_restore exited with code 1" on its own is not
       * something anybody can act on at the moment the database is empty.
       */
      if (code === 0) return resolve();
      reject(new Error(stderr.trim() || `pg_restore exited with code ${code}.`));
    });
  });
}

/** `prisma migrate deploy` against this workspace's database, through the local Prisma CLI. */
export function migrateDeploy(databaseUrl: string): Promise<void> {
  const cli = path.join(process.cwd(), "node_modules", "prisma", "build", "index.js");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "migrate", "deploy"], { shell: false, env: { ...process.env, DATABASE_URL: databaseUrl } });
    let output = "";
    child.stdout?.on("data", (c) => (output += String(c)));
    child.stderr?.on("data", (c) => (output += String(c)));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(output.trim() || `prisma migrate deploy exited ${code}`))));
  });
}

export function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false });
    let stderr = "";
    child.stderr?.on("data", (c) => {
      stderr += String(c);
    });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `${command} exited ${code}`))));
  });
}
