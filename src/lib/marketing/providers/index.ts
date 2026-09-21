import type { MessageClass, ProviderKind } from "@prisma/client";
import { EMAIL_PROVIDERS } from "@/lib/marketing/providers/email";
import { WHATSAPP_PROVIDERS } from "@/lib/marketing/providers/whatsapp";
import type { MessageProvider } from "@/lib/marketing/providers/types";

export * from "@/lib/marketing/providers/types";

export const PROVIDERS: MessageProvider[] = [...EMAIL_PROVIDERS, ...WHATSAPP_PROVIDERS];

export const providerByKey: Record<string, MessageProvider> = Object.fromEntries(
  PROVIDERS.map((p) => [p.key, p]),
);

export function providersOfKind(kind: ProviderKind): MessageProvider[] {
  return PROVIDERS.filter((p) => p.kind === kind);
}

/** A row as the router sees it — no secret, because routing never needs one. */
export type RoutableProvider = {
  id: string;
  key: string;
  label: string;
  kind: ProviderKind;
  enabled: boolean;
  priority: number;
  classes: MessageClass[];
  fromEmail: string | null;
};

/**
 * Which provider carries this message, and which to fall back to.
 *
 * The ordering rule that matters: a provider only carries a class it was configured to carry. That
 * is what keeps bulk off the domain the invoices go out from — Microsoft 365 set to TRANSACTIONAL
 * only will never be picked up by a campaign, however many other providers are failing.
 *
 * The list is a failover chain, not alternatives. It is walked in order, and only a *retryable*
 * failure moves to the next one; a rejected address is a rejected address at every provider.
 */
export function routeFor(
  providers: RoutableProvider[],
  params: { kind: ProviderKind; messageClass: MessageClass },
): RoutableProvider[] {
  return providers
    .filter((p) => p.enabled && p.kind === params.kind && p.classes.includes(params.messageClass))
    .sort((a, b) => a.priority - b.priority || a.key.localeCompare(b.key));
}

/**
 * Whether marketing is about to go out from the same domain as everything else.
 *
 * The single most consequential setting in the module. Bulk from the primary domain risks the
 * deliverability of quotes, invoices and password resets — the mail the business actually runs on —
 * and the damage arrives weeks later, as silence.
 */
export function sharesDomainWithTransactional(providers: RoutableProvider[]): boolean {
  const domainOf = (p: RoutableProvider) => p.fromEmail?.split("@")[1]?.trim().toLowerCase() ?? null;
  const marketing = new Set(
    providers.filter((p) => p.enabled && p.classes.includes("MARKETING")).map(domainOf).filter(Boolean),
  );
  const transactional = providers
    .filter((p) => p.enabled && p.classes.includes("TRANSACTIONAL"))
    .map(domainOf)
    .filter(Boolean);
  return transactional.some((d) => marketing.has(d));
}
