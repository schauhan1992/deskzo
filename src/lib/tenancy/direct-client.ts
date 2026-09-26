import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

/**
 * Prisma reaches a workspace database through its pg driver adapter: node-postgres does the
 * talking, Prisma compiles the queries (engineType "client" in prisma/schema.prisma — no Rust engine).
 *
 * The addresses the platform keeps are Prisma's: `?schema=public`, and the old engine's pool settings
 * in the query string. The driver takes a pool config instead, so they are read out of the address
 * into one and removed from it — nothing Prisma-only reaches the server as a connection parameter.
 * SSL settings (sslmode, sslcert…) and application_name stay: the driver reads them from the address.
 */
const PRISMA_ONLY = ["schema", "connection_limit", "pool_timeout", "connect_timeout", "socket_timeout", "pgbouncer", "max_idle_connection_lifetime", "statement_cache_size", "sslaccept"];

/** The part of node-postgres's pool config used here (the driver ships no types of its own). */
export type PoolConfig = { connectionString: string; max: number; idleTimeoutMillis: number; connectionTimeoutMillis: number };

export type PoolSettings = { pool: PoolConfig; schema: string };

/**
 * An address as the driver takes it. `max` and `idleSeconds` are what to use when the address does
 * not say (connection_limit, max_idle_connection_lifetime); waiting for a connection gives up after
 * pool_timeout or connect_timeout seconds, ten by default.
 */
export function poolSettings(url: string, defaults: { max: number; idleSeconds?: number }): PoolSettings {
  const u = new URL(url);
  const read = (name: string) => {
    const n = Number(u.searchParams.get(name));
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const schema = u.searchParams.get("schema")?.trim() || "public";
  const max = read("connection_limit") ?? defaults.max;
  const idleSeconds = read("max_idle_connection_lifetime") ?? defaults.idleSeconds ?? 30;
  const waitSeconds = Math.max(read("pool_timeout") ?? 0, read("connect_timeout") ?? 0) || 10;
  for (const name of PRISMA_ONLY) u.searchParams.delete(name);
  return {
    pool: { connectionString: u.toString(), max, idleTimeoutMillis: idleSeconds * 1000, connectionTimeoutMillis: waitSeconds * 1000 },
    schema,
  };
}

/**
 * A client of its own on one database — for scripts, seeds, the provisioner and workers, which know
 * the address they want. Requests never use one: they use `db` (src/lib/db.ts), which finds the
 * workspace the work is for and shares one client between all of them (src/lib/tenancy/clients.ts).
 *
 * Close it with $disconnect() when done, as before: that ends its pool.
 */
export function directClient(url: string | undefined = process.env.DATABASE_URL, options: { max?: number } = {}): PrismaClient {
  if (!url) throw new Error("No database address — set DATABASE_URL, or pass one.");
  const { pool, schema } = poolSettings(url, { max: options.max ?? 10 });
  return new PrismaClient({ adapter: new PrismaPg(pool, { schema }) });
}
