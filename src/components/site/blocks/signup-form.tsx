import { Check } from "lucide-react";
import type { SignupFormProps, SiteRenderContext } from "@/components/site/blocks/types";
import { fill } from "@/components/site/links";
import { Container } from "@/components/site/ui";
import { SignupFlow, type SignupReferral } from "@/components/platform/signup-flow";
import { COUNTRIES } from "@/lib/geo/countries";
import { SLUG_PATTERN } from "@/lib/workspace-names";

/**
 * A partner's referral, as the signup page put it in the query (src/app/platform-site/signup/page.tsx):
 * that page drops whatever a visitor sent under these names and sets them only for a live code.
 */
function referralFrom(query: SiteRenderContext["searchParams"]): SignupReferral | null {
  const code = String(query.ref ?? "").trim();
  const partnerName = String(query.refName ?? "").trim();
  const via = query.refVia;
  return code && partnerName && (via === "link" || via === "cookie") ? { code, partnerName, via } : null;
}

/**
 * The invitation code from the signup link (`?invite=`), and the address it holds as the signup page
 * looked it up (`held`) — that page drops any `held` a visitor sends, and the site drops it everywhere
 * else (src/components/site/page-view.tsx), so a hand-made link can't lock somebody's address field.
 */
function invitationFrom(query: SiteRenderContext["searchParams"]): { invite: string; held: string | null } {
  const invite = String(query.invite ?? "").trim().slice(0, 100);
  const held = String(query.held ?? "").trim();
  return { invite, held: invite && SLUG_PATTERN.test(held) ? held : null };
}

/**
 * Setting up a workspace: the page's h1 and what comes with it, beside the signup flow itself
 * (src/components/platform/signup-flow.tsx; src/actions/platform/signup.ts does the work).
 */
export function SignupFormBlock({ props, ctx }: { props: SignupFormProps; ctx: SiteRenderContext }) {
  const t = (s?: string) => fill(s, ctx);
  const body = t(ctx.signupOpen ? props.body : (props.bodyInviteOnly ?? props.body));
  return (
    <section className="relative overflow-hidden">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_60%_at_0%_0%,color-mix(in_srgb,var(--brand)_12%,transparent),transparent_70%)]" />
      <Container className="relative py-12 sm:py-20">
        <div className="grid items-start gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,28rem)] lg:gap-16">
          <div className="max-w-xl">
            <h1 className="text-4xl font-semibold tracking-tight text-text text-balance sm:text-5xl">{t(props.heading)}</h1>
            {body && <p className="mt-5 text-base leading-7 text-muted sm:text-lg sm:leading-8">{body}</p>}
            {!!props.asideItems?.length && (
              <div className="mt-10">
                {props.asideHeading && <h2 className="text-sm font-semibold text-text">{t(props.asideHeading)}</h2>}
                <ul className="mt-4 space-y-3">
                  {props.asideItems.map((item, i) => (
                    <li key={i} className="flex gap-3 text-sm leading-6 text-text">
                      <Check aria-hidden="true" className="mt-1 h-4 w-4 shrink-0 text-brand" />
                      <span>{t(item)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <div className="rounded-2xl border border-line bg-surface p-6 shadow-lg sm:p-8">
            <SignupFlow suffix={ctx.workspaceSuffix} countries={COUNTRIES} inviteRequired={!ctx.signupOpen} referral={referralFrom(ctx.searchParams)} {...invitationFrom(ctx.searchParams)} />
          </div>
        </div>
      </Container>
    </section>
  );
}
