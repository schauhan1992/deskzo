import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";

/**
 * Making and removing a workspace's database on the Postgres server.
 *
 * Each workspace gets a database of its own, owned by a login role of its own:
 *
 *   · not a superuser, cannot create databases or roles — it can do exactly what the app does;
 *   · CONNECT on its database is revoked from PUBLIC, so no other workspace's role can even open it;
 *   · its password is random, and exists only inside the workspace's sealed database address.
 *
 * The provisioner — PLATFORM_PROVISIONER_URL, a role with CREATEDB and CREATEROLE, connected to the
 * server's maintenance database — is the only thing that makes or drops them. In development it
 * falls back to DATABASE_URL's server and credentials.
 *
 * Names are generated here, never taken from input: `w_` and twelve hex characters, for both the
 * database and its role.
 */

export type WorkspaceDatabase = { dbName: string; dbRole: string; url: string };

const NAME = /^w_[0-9a-f]{12}$/;

function provisionerUrl(): string {
  const configured = process.env.PLATFORM_PROVISIONER_URL?.trim();
  if (configured) return configured;
  const fallback = process.env.DATABASE_URL;
  if (!fallback) throw new Error("PLATFORM_PROVISIONER_URL is not set — see .env.example.");
  const u = new URL(fallback);
  u.pathname = "/postgres";
  u.search = "";
  return u.toString();
}

async function withProvisioner<T>(work: (admin: PrismaClient) => Promise<T>): Promise<T> {
  const admin = new PrismaClient({ datasourceUrl: provisionerUrl() });
  try {
    return await work(admin);
  } finally {
    await admin.$disconnect();
  }
}

/** The address a workspace's app connections use: the server's, with the workspace's own role. */
function workspaceUrl(dbName: string, dbRole: string, password: string): string {
  const u = new URL(provisionerUrl());
  u.username = dbRole;
  u.password = password;
  u.pathname = `/${dbName}`;
  u.search = "?schema=public";
  return u.toString();
}

export async function createWorkspaceDatabase(): Promise<WorkspaceDatabase> {
  const name = `w_${randomBytes(6).toString("hex")}`;
  // URL-safe and quote-free, so it goes into both the SQL literal and the address untouched.
  const password = randomBytes(24).toString("base64url");
  await withProvisioner(async (admin) => {
    await admin.$executeRawUnsafe(`CREATE ROLE "${name}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    try {
      // Postgres 16 lets a CREATEROLE role make a database owned by a role only if it may act as
      // that role; a superuser already may.
      await admin.$executeRawUnsafe(`GRANT "${name}" TO CURRENT_USER`).catch(() => {});
      await admin.$executeRawUnsafe(`CREATE DATABASE "${name}" OWNER "${name}"`);
      await admin.$executeRawUnsafe(`REVOKE CONNECT, TEMPORARY ON DATABASE "${name}" FROM PUBLIC`);
    } catch (err) {
      await admin.$executeRawUnsafe(`DROP ROLE IF EXISTS "${name}"`).catch(() => {});
      throw err;
    }
  });
  return { dbName: name, dbRole: name, url: workspaceUrl(name, name, password) };
}

/** Drops a workspace's database and its role. Refuses any name it did not make. */
export async function dropWorkspaceDatabase(dbName: string, dbRole: string): Promise<void> {
  if (!NAME.test(dbName) || !NAME.test(dbRole)) throw new Error(`Refusing to drop "${dbName}" / "${dbRole}": not a workspace database this platform made.`);
  await withProvisioner(async (admin) => {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`DROP ROLE IF EXISTS "${dbRole}"`);
  });
}

/** Whether a workspace database exists on the server — for checks and the console. */
export async function workspaceDatabaseExists(dbName: string): Promise<boolean> {
  return withProvisioner(async (admin) => (await admin.$queryRaw<unknown[]>`select 1 from pg_database where datname = ${dbName}`).length > 0);
}
