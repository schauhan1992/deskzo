"use server";

import type { StaffRole } from "@deskzo/control-client";
import type { ConsoleResult } from "@/actions/platform/console";
import { CHORES, requestChore, type Chore } from "@/lib/offsite/chores";
import { offsiteSetup, parseKeepDays, parseStoreConfig, storedConfig } from "@/lib/offsite/config";
import { OffsiteError, checkStore, openStore, type CheckStep, type StoreConfig } from "@/lib/offsite/store";
import { MANAGERS, OWNERS, consoleAudit, consoleRefusal, revalidateConsole } from "@/lib/platform/console-guard";
import { controlDb } from "@/lib/platform/control-db";
import { ConsoleRefused } from "@/lib/platform/refused";
import { getSecret, setSecret, setSetting } from "@/lib/platform/settings";
import { StaffRefused, requireStaff, type Staff } from "@/lib/platform/staff-session";

/**
 * Settings › Backups & logs (src/lib/offsite): where backups and logs are kept off the server, and for
 * how long.
 *
 *   Save, Turn off       owners — it decides where every workspace's data is copied
 *   Check connection     owners and admins; an owner may check what is typed before saving it
 *   Run now              owners and admins: the platform worker runs it within a minute
 *
 * The SAS token or secret key is sealed as it is saved and never shown back; an empty field keeps the
 * one saved. Every change is in the platform audit log — the store's address, never its secret.
 */

async function asStaff<T>(roles: readonly StaffRole[], work: (staff: Staff) => Promise<T>): Promise<ConsoleResult<T>> {
  let staff: Staff;
  try {
    staff = await requireStaff(roles);
  } catch (err) {
    if (err instanceof StaffRefused) return { ok: false, error: err.message };
    throw err;
  }
  try {
    return { ok: true, data: await work(staff) };
  } catch (err) {
    if (err instanceof OffsiteError) return { ok: false, error: err.message };
    const refusal = consoleRefusal(err);
    if (refusal !== null) return { ok: false, error: refusal };
    throw err;
  }
}

export type OffsiteInput = {
  provider?: unknown;
  containerUrl?: unknown;
  endpoint?: unknown;
  region?: unknown;
  bucket?: unknown;
  accessKeyId?: unknown;
  pathStyle?: unknown;
  path?: unknown;
  prefix?: unknown;
  /** The SAS token or secret access key; empty keeps the saved one. */
  secret?: unknown;
  backupKeepDays?: unknown;
  logKeepDays?: unknown;
};

/**
 * The store's settings and the secret to use with them. A SAS token pasted onto the container's address
 * is split off into the secret. An empty secret means the saved one — but only for the same kind of
 * store, as an S3 secret is no SAS token.
 */
async function readInput(input: OffsiteInput): Promise<{ config: StoreConfig; secret: string | null; typedSecret: string | null }> {
  const raw = { ...input };
  let typed = typeof raw.secret === "string" ? raw.secret.trim() : "";
  if (raw.provider === "azure" && typeof raw.containerUrl === "string" && raw.containerUrl.includes("?")) {
    const [address, query] = raw.containerUrl.trim().split("?", 2);
    raw.containerUrl = address;
    if (!typed) typed = query;
  }
  const config = parseStoreConfig(raw);
  if (config.provider === "filesystem") return { config, secret: null, typedSecret: null };
  if (typed) {
    if (typed.length > 2000 || /\s/.test(typed)) throw new ConsoleRefused(config.provider === "azure" ? "Paste the SAS token exactly as Azure showed it." : "Paste the secret access key exactly as it was shown.");
    if (config.provider === "azure" && !/(^|&|\?)sig=/.test(typed)) throw new ConsoleRefused("That isn't a SAS token — it has no signature (sig=…). Generate one for the container with read, add, create, write, delete and list.");
    return { config, secret: typed.replace(/^\?/, ""), typedSecret: typed.replace(/^\?/, "") };
  }
  const saved = await offsiteSetup();
  const secret = saved.config?.provider === config.provider ? await getSecret("offsite.secret") : null;
  if (!secret) throw new ConsoleRefused(config.provider === "azure" ? "Paste the SAS token." : "Paste the secret access key.");
  return { config, secret, typedSecret: null };
}

const describe = (config: StoreConfig) => openStore(config, "-").label;

export async function consoleSaveOffsite(input: OffsiteInput): Promise<ConsoleResult<null>> {
  return asStaff(OWNERS, async (staff) => {
    const { config, typedSecret } = await readInput(input ?? {});
    const backupKeepDays = parseKeepDays(input?.backupKeepDays, "backups");
    const logKeepDays = parseKeepDays(input?.logKeepDays, "logs");
    await setSetting("offsite.provider", config.provider, staff.id);
    await setSetting("offsite.config", storedConfig(config), staff.id);
    if (config.provider === "filesystem") await setSecret("offsite.secret", null, staff.id);
    else if (typedSecret) await setSecret("offsite.secret", typedSecret, staff.id);
    await setSetting("offsite.backupKeepDays", String(backupKeepDays), staff.id);
    await setSetting("offsite.logKeepDays", String(logKeepDays), staff.id);
    await consoleAudit(staff, "offsite.save", { store: describe(config), secret: config.provider === "filesystem" ? "none" : typedSecret ? "replaced" : "kept", backupKeepDays, logKeepDays });
    revalidateConsole();
    return null;
  });
}

/** Checks the store: what is typed when an owner passes it, otherwise what is saved. Nothing is saved. */
export async function consoleCheckOffsite(input?: OffsiteInput | null): Promise<ConsoleResult<{ label: string; steps: CheckStep[] }>> {
  return asStaff(input ? OWNERS : MANAGERS, async () => {
    let config: StoreConfig;
    let secret: string | null;
    if (input) {
      ({ config, secret } = await readInput(input));
    } else {
      const saved = await offsiteSetup();
      if (!saved.config) throw new ConsoleRefused("No store is saved yet.");
      config = saved.config;
      secret = config.provider === "filesystem" ? null : await getSecret("offsite.secret");
    }
    const store = openStore(config, secret);
    return { label: store.label, steps: await checkStore(store) };
  });
}

/** Stops copying anything off-site. What is in the store stays there. */
export async function consoleTurnOffOffsite(): Promise<ConsoleResult<null>> {
  return asStaff(OWNERS, async (staff) => {
    const saved = await offsiteSetup();
    if (!saved.config) throw new ConsoleRefused("No store is set up.");
    await setSetting("offsite.provider", null, staff.id);
    await setSetting("offsite.config", null, staff.id);
    await setSecret("offsite.secret", null, staff.id);
    await consoleAudit(staff, "offsite.off", { store: describe(saved.config) });
    revalidateConsole();
    return null;
  });
}

/** Asks the platform worker to run one now. A drill may name a workspace by its address name. */
export async function consoleRunOffsite(chore: unknown, workspace?: unknown): Promise<ConsoleResult<null>> {
  return asStaff(MANAGERS, async (staff) => {
    if (typeof chore !== "string" || !(CHORES as readonly string[]).includes(chore)) throw new ConsoleRefused("Choose what to run.");
    let tenantId: string | null = null;
    const slug = typeof workspace === "string" ? workspace.trim().toLowerCase() : "";
    if (chore === "drill" && slug) {
      const tenant = await controlDb().tenant.findUnique({ where: { slug }, select: { id: true } });
      if (!tenant) throw new ConsoleRefused(`There is no workspace "${slug}".`);
      const offsite = await controlDb().offsiteWorkspace.findUnique({ where: { tenantId: tenant.id }, select: { backups: true } });
      if (!offsite?.backups) throw new ConsoleRefused(`${slug} has no backups off-site yet.`);
      tenantId = tenant.id;
    }
    if (chore !== "clock" && !(await offsiteSetup()).config && chore !== "control") throw new ConsoleRefused("Set up the off-site store first.");
    await requestChore({ chore: chore as Chore, by: `staff:${staff.id}`, tenantId });
    await consoleAudit(staff, "offsite.run", { chore, workspace: slug || null }, tenantId);
    revalidateConsole();
    return null;
  });
}
