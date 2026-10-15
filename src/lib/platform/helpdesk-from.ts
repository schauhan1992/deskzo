import { controlConfigured } from "@/lib/platform/control-db";
import { getSetting, setSetting } from "@/lib/platform/settings";

/**
 * Whether workspaces' helpdesk replies through Deskzo's mail go out from each workspace's own helpdesk
 * address — wroffy@tickets.deskzo.com, the address customers write to — rather than from the Support
 * account's address with Reply-To set to it (owner, 15 Oct 2026; src/lib/support-mail/reply-from.ts).
 *
 * An owner turns it on in the console (Settings › Mail) once the Support mail account may send for the
 * helpdesk domain: its DKIM records, and its SPF entry beside Cloudflare's, on that domain
 * (docs/deploy-coolify.md, "Tickets by email"). Off by default: a mail service not allowed to send for the
 * domain would refuse the address — a reply it refuses still goes, from the account's own address.
 */

const KEY = "mail.helpdesk.fromOwnAddress";

/** A minute's copy: every workspace reads the same answer, and a reply shouldn't wait on the control plane. */
let cached: { at: number; on: boolean } | null = null;
let testValue: boolean | null = null;

/** Set only by check scripts. */
export function setTestHelpdeskFromOwnAddress(on: boolean | null) {
  testValue = on;
}

export async function helpdeskFromOwnAddress(): Promise<boolean> {
  if (testValue !== null) return testValue;
  if (cached && Date.now() - cached.at < 60_000) return cached.on;
  let on = false;
  if (controlConfigured()) {
    try {
      on = (await getSetting(KEY)) === "1";
    } catch {
      // A control plane out of reach: the account's own address, which always works.
      on = false;
    }
  }
  cached = { at: Date.now(), on };
  return on;
}

/** The console's save. */
export async function saveHelpdeskFromOwnAddress(on: boolean, by: string): Promise<boolean> {
  await setSetting(KEY, on ? "1" : "0", by);
  cached = null;
  return on;
}
