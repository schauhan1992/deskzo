import { currentTenant } from "@/lib/tenancy/resolve";
import { addressFor } from "@/lib/support-mail/rules";

/**
 * Where tickets by email are received: INBOUND_MAIL_DOMAIN (tickets.deskzo.com), set up once for the
 * whole platform (docs/deploy-coolify.md, "Tickets by email"). Null where it isn't, and then no
 * workspace has an address — the settings page says so rather than showing one that goes nowhere.
 */
export function inboundDomain(): string | null {
  const domain = process.env.INBOUND_MAIL_DOMAIN?.trim().toLowerCase();
  return domain && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain) ? domain : null;
}

/** This workspace's helpdesk address, or null where the platform receives no mail. */
export async function workspaceSupportAddress(): Promise<string | null> {
  const domain = inboundDomain();
  if (!domain) return null;
  return addressFor((await currentTenant()).slug, domain);
}
