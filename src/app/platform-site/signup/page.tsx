import type { Metadata } from "next";
import { cookies } from "next/headers";
import { heldAddress } from "@/actions/platform/signup";
import { SitePageView, sitePageMetadata } from "@/components/site/page-view";
import { findActiveReferral } from "@/lib/partners/referrals";
import { controlConfigured } from "@/lib/platform/control-db";

/**
 * Setting up a workspace — src/actions/platform/signup.ts does the work. Kept out of search engines.
 *
 * A partner's referral code (spec §4.2) comes from the link (`?ref=`) or — only when the address has
 * none — from the referral cookie the proxy sets once an owner turns it on (src/proxy.ts). It is
 * checked here, and only a live one reaches the form (src/components/site/blocks/signup-form.tsx),
 * with its partner's name: any `ref`, `refVia` or `refName` a visitor sends is dropped first, and a
 * code that isn't live is dropped without a word.
 *
 * An invitation code may come in the link too (`?invite=`): it fills the form's code in, and when it
 * holds an address for its customer, the page looks that up and passes it on as `held` — any `held`
 * a visitor sends is dropped first — so the form opens with the address filled in and locked.
 */

const REFERRAL_COOKIE = "deskzo_ref";

type Query = Record<string, string | string[] | undefined>;

const firstValue = (value: string | string[] | undefined) => String((Array.isArray(value) ? value[0] : value) ?? "").trim();

/** The live referral link behind a code, with its partner's name — null for anything else, including a control plane that can't answer. */
async function liveReferral(code: string): Promise<{ code: string; partnerName: string } | null> {
  if (!code || !controlConfigured()) return null;
  try {
    const referral = await findActiveReferral(code, new Date());
    return referral ? { code: referral.code, partnerName: referral.partnerName } : null;
  } catch (err) {
    console.warn(`[site] a referral code could not be checked, so the signup form shows none: ${(err as { code?: string } | null)?.code ?? (err instanceof Error ? err.name : "error")}`);
    return null;
  }
}

export async function generateMetadata(): Promise<Metadata> {
  return sitePageMetadata("signup");
}

/**
 * The address an invitation code from the link holds, for the form to fill in and lock — through the
 * same limited lookup the form uses (`heldAddress`). Null for anything else, a control plane that can't
 * answer included.
 */
async function heldFor(invite: string): Promise<string | null> {
  if (!invite || !controlConfigured()) return null;
  try {
    return (await heldAddress(invite))?.slug ?? null;
  } catch (err) {
    console.warn(`[site] an invitation code could not be looked up, so the signup form holds no address: ${(err as { code?: string } | null)?.code ?? (err instanceof Error ? err.name : "error")}`);
    return null;
  }
}

export default async function SignupPage({ searchParams }: PageProps<"/platform-site/signup">) {
  const query: Query = { ...(await searchParams) };
  const fromLink = firstValue(query.ref);
  delete query.ref;
  delete query.refVia;
  delete query.refName;
  const code = fromLink || firstValue((await cookies()).get(REFERRAL_COOKIE)?.value);
  const referral = await liveReferral(code);
  if (referral) Object.assign(query, { ref: referral.code, refVia: fromLink ? "link" : "cookie", refName: referral.partnerName });
  // An invitation code in the link (`?invite=`) fills the code in; one that holds an address fills that in too, locked.
  delete query.held;
  const invite = firstValue(query.invite).slice(0, 100);
  if (invite) query.invite = invite;
  const held = await heldFor(invite);
  if (held) query.held = held;
  return <SitePageView slug="signup" searchParams={query} trustedReferral />;
}
