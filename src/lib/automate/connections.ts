import { z } from "zod";
import { db } from "@/lib/db";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { ActionError } from "@/lib/automate/action-types";

/**
 * Outside apps a workflow may call (Deskzo Automate, Phase 4) — `automation_connections`. Each holds
 * its secret encrypted with the workspace's own data key; screens are told only whether one is set,
 * never what it is.
 *
 *   · slack  — a Slack incoming-webhook address.
 *   · teams  — a Teams "post to a channel when a webhook request is received" address (the Workflows
 *              app's, which replaced the old Office 365 connectors).
 *   · http   — an outside API: its base address and the headers it wants (an API key, a bearer token).
 *
 * A connection is its owner's; shared with the workspace, any workflow may use it. A workflow uses one
 * only when its owner may — so sharing is how a team's Slack is used by everybody's workflows.
 */

export const CONNECTION_PROVIDERS = ["slack", "teams", "http"] as const;
export type ConnectionProvider = (typeof CONNECTION_PROVIDERS)[number];

export const PROVIDER_LABELS: Record<ConnectionProvider, string> = { slack: "Slack", teams: "Microsoft Teams", http: "An outside API" };

const https = (label: string) =>
  z
    .string()
    .trim()
    .url(`${label} isn't a web address.`)
    .max(2000)
    .refine((u) => u.startsWith("https://"), `${label} must start with https://.`);

const SECRETS = {
  slack: z.object({ url: https("The webhook address").refine((u) => /^https:\/\/hooks\.slack\.com\//.test(u), "A Slack webhook address starts with https://hooks.slack.com/.") }).strict(),
  teams: z.object({ url: https("The webhook address") }).strict(),
  http: z
    .object({
      url: https("The base address"),
      headers: z
        .record(z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9-]+$/, "A header's name is letters, digits and hyphens."), z.string().max(2000))
        .refine((h) => Object.keys(h).length <= 20, "At most 20 headers.")
        .default({}),
    })
    .strict(),
} as const;

export type ConnectionSecret<P extends ConnectionProvider> = z.infer<(typeof SECRETS)[P]>;

/** What screens see of a connection: never its secret. */
export type ConnectionRow = { id: string; provider: string; name: string; ownerUserId: string; sharedWithWorkspace: boolean; hasSecret: boolean; status: string; lastUsedAt: Date | null; lastError: string | null; host: string | null };

export async function listConnections(): Promise<ConnectionRow[]> {
  const rows = await db.automationConnection.findMany({ orderBy: { createdAt: "asc" }, select: { id: true, provider: true, name: true, ownerUserId: true, sharedWithWorkspace: true, credentialsCipher: true, status: true, lastUsedAt: true, lastError: true, scopes: true } });
  return rows.map(({ credentialsCipher, scopes, ...r }) => ({ ...r, hasSecret: !!credentialsCipher, host: scopes[0] ?? null }));
}

export type SaveConnection = { id?: string; provider: string; name: string; shared: boolean; secret?: unknown };

/**
 * Makes or changes a connection. A secret given replaces the old one whole; none keeps it. The host it
 * points at is kept in the clear (in `scopes`) so the list can say where it goes without decrypting.
 */
export async function saveConnection(input: SaveConnection, ownerId: string): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (!(CONNECTION_PROVIDERS as readonly string[]).includes(input.provider)) return { ok: false, error: "Choose Slack, Teams or an outside API." };
  const provider = input.provider as ConnectionProvider;
  const name = input.name.trim().slice(0, 80);
  if (!name) return { ok: false, error: "Give the connection a name." };
  const existing = input.id ? await db.automationConnection.findUnique({ where: { id: input.id }, select: { id: true, provider: true, ownerUserId: true } }) : null;
  if (input.id && !existing) return { ok: false, error: "That connection no longer exists." };
  if (existing && existing.provider !== provider) return { ok: false, error: "A connection keeps its kind." };
  let secretFields: { credentialsCipher?: string; scopes?: string[] } = {};
  if (input.secret !== undefined) {
    const parsed = SECRETS[provider].safeParse(input.secret);
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the details." };
    secretFields = { credentialsCipher: await encryptSecret(JSON.stringify(parsed.data)), scopes: [new URL(parsed.data.url).host] };
  } else if (!existing) {
    return { ok: false, error: "Give the address to connect to." };
  }
  const data = { name, sharedWithWorkspace: input.shared, status: "ACTIVE", lastError: null, ...secretFields };
  const saved = existing ? await db.automationConnection.update({ where: { id: existing.id }, data, select: { id: true } }) : await db.automationConnection.create({ data: { ...data, provider, ownerUserId: ownerId }, select: { id: true } });
  return { ok: true, id: saved.id };
}

export async function deleteConnection(id: string): Promise<boolean> {
  return (await db.automationConnection.deleteMany({ where: { id } })).count === 1;
}

/** A connection a workflow owned by `actorId` may use, with its secret — or refused, saying why. */
export async function connectionFor<P extends ConnectionProvider>(actorId: string, id: string, provider: P): Promise<{ id: string; name: string; secret: ConnectionSecret<P> }> {
  const row = await db.automationConnection.findUnique({ where: { id }, select: { id: true, name: true, provider: true, ownerUserId: true, sharedWithWorkspace: true, credentialsCipher: true, status: true } });
  if (!row || row.provider !== provider) throw new ActionError(`That ${PROVIDER_LABELS[provider]} connection isn't there.`, "PERMANENT");
  if (row.ownerUserId !== actorId && !row.sharedWithWorkspace) throw new ActionError(`"${row.name}" is somebody else's and isn't shared with the workspace.`, "PERMANENT");
  if (!row.credentialsCipher) throw new ActionError(`"${row.name}" has no address set.`, "PERMANENT");
  const parsed = SECRETS[provider].safeParse(JSON.parse(await decryptSecret(row.credentialsCipher)));
  if (!parsed.success) throw new ActionError(`"${row.name}" needs setting up again.`, "PERMANENT");
  return { id: row.id, name: row.name, secret: parsed.data as ConnectionSecret<P> };
}

/** What happened the last time a connection was used, for its row on the Connections page. */
export async function noteConnectionUse(id: string, error: string | null): Promise<void> {
  await db.automationConnection.update({ where: { id }, data: { lastUsedAt: new Date(), lastError: error ? error.slice(0, 500) : null } }).catch(() => undefined);
}
