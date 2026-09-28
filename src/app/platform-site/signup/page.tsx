import type { Metadata } from "next";
import { cookies } from "next/headers";
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
 */

const REFERRAL_COOKIE = "wroffy_ref";

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

export default async function SignupPage({ searchParams }: PageProps<"/platform-site/signup">) {
  const query: Query = { ...(await searchParams) };
  const fromLink = firstValue(query.ref);
  delete query.ref;
  delete query.refVia;
  delete query.refName;
  const code = fromLink || firstValue((await cookies()).get(REFERRAL_COOKIE)?.value);
  const referral = await liveReferral(code);
  if (referral) Object.assign(query, { ref: referral.code, refVia: fromLink ? "link" : "cookie", refName: referral.partnerName });
  return <SitePageView slug="signup" searchParams={query} trustedReferral />;
}
