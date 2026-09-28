import type { Metadata } from "next";
import { ArrowRight } from "lucide-react";
import { IconChip } from "@/components/site/icons";
import { fill } from "@/components/site/links";
import { PartnerApplicationForm } from "@/components/site/partners/application-form";
import { applicationsShown, siteCopy } from "@/components/site/partners/programme";
import { ButtonLink, Container, Eyebrow, Section, SectionHeading, SiteAnchor } from "@/components/site/ui";
import type { IconName } from "@/components/site/blocks/types";
import { COUNTRIES } from "@/lib/geo/countries";
import { partnerOrigin } from "@/lib/partners/users";

/**
 * "Become a partner" (spec §10, D17): the partner programme in a few lines, and the application form
 * (src/actions/platform/partner-site.ts), which writes partner_applications for staff to review in the
 * console — never the CMS's leads inbox. A fixed route, not a CMS page ("partners" is a reserved first
 * segment in src/lib/cms/types.ts); its words name the site through {siteName}, as the brand is the
 * site's setting. While an owner has closed applications (partners.applications) the page says so and
 * shows no form.
 */

const TITLE = "Become a partner";
const DESCRIPTION = "Sell {siteName} to the companies you work with and earn a recurring commission. We bill and support your customers; you follow everything in your own partner portal.";

const BENEFITS: { icon: IconName; title: string; body: string }[] = [
  {
    icon: "chart",
    title: "Recurring commission",
    body: "A share of what your customers pay, on every invoice they pay — not a one-off fee. Your rates are agreed with you when you join.",
  },
  {
    icon: "headset",
    title: "We bill and support your customers",
    body: "{siteName} invoices your customers, collects their payments and answers their support questions, so your time goes on selling and advising.",
  },
  {
    icon: "layers",
    title: "Your own partner portal",
    body: "Your customers, invitation codes and referral links, commissions and monthly statements — all in one place.",
  },
];

const NEXT_STEPS = [
  { title: "We read your application", body: "Every one, and we reply by email." },
  { title: "We agree your terms", body: "Your commission rates and the countries you sell in." },
  { title: "You get your partner portal", body: "Invite your first customers and follow them from there." },
];

export async function generateMetadata(): Promise<Metadata> {
  const ctx = await siteCopy();
  const description = fill(DESCRIPTION, ctx);
  return {
    title: TITLE,
    description,
    alternates: { canonical: "/partners" },
    openGraph: { type: "website", siteName: ctx.settings.siteName, title: TITLE, description, url: "/partners" },
    twitter: { card: "summary", title: TITLE, description },
  };
}

export default async function BecomePartnerPage() {
  const [ctx, open] = await Promise.all([siteCopy(), applicationsShown()]);
  const t = (s: string) => fill(s, ctx);
  const portal = `${partnerOrigin()}/login`;
  return (
    <>
      <section className="relative overflow-hidden border-b border-line">
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_80%_at_0%_0%,color-mix(in_srgb,var(--brand)_10%,transparent),transparent_70%)]" />
        <Container className="relative py-14 sm:py-20">
          <div className="max-w-3xl">
            <Eyebrow>Partner programme</Eyebrow>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight text-text text-balance sm:text-5xl">{TITLE}</h1>
            <p className="mt-5 text-base leading-7 text-muted text-pretty sm:text-lg sm:leading-8">
              {t("Sell {siteName} to the companies you already work with. You stay their trusted adviser; we run the software, bill them and support them — and you earn a recurring commission on what they pay.")}
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
              {open && <ButtonLink href="#apply" label="Apply to join" size="lg" arrow />}
              <SiteAnchor href={portal} className="inline-flex items-center gap-1 text-sm font-medium text-brand hover:underline">
                Already a partner? Sign in to the partner portal
                <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
              </SiteAnchor>
            </div>
          </div>
        </Container>
      </section>

      <Section>
        <SectionHeading heading="What partners get" />
        <ul className="mt-12 grid gap-6 md:grid-cols-3">
          {BENEFITS.map((benefit) => (
            <li key={benefit.title} className="flex flex-col rounded-2xl border border-line bg-surface p-6 shadow-sm sm:p-8">
              <IconChip name={benefit.icon} />
              <h3 className="mt-5 text-lg font-semibold text-text">{benefit.title}</h3>
              <p className="mt-2 text-sm leading-6 text-muted">{t(benefit.body)}</p>
            </li>
          ))}
        </ul>
      </Section>

      <section id="apply" className="scroll-mt-20 border-t border-line bg-surface-sunken py-12 sm:py-16">
        <Container>
          <div className="grid gap-10 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:gap-16">
            <div className="rounded-2xl border border-line bg-surface p-6 shadow-sm sm:p-8">
              {open ? (
                <>
                  <h2 className="text-xl font-semibold text-text">Apply to join</h2>
                  <p className="mt-2 text-sm leading-6 text-muted">Tell us about your company and how you would like to work with us.</p>
                  <div className="mt-6">
                    <PartnerApplicationForm countries={COUNTRIES} />
                  </div>
                </>
              ) : (
                <div className="py-6">
                  <h2 className="text-xl font-semibold text-text">Applications are closed for now.</h2>
                  <p className="mt-2 text-sm leading-6 text-muted">To talk to us about working together in the meantime, get in touch with our sales team.</p>
                  <ButtonLink href="/contact?topic=sales" label="Contact sales" tone="secondary" className="mt-6" arrow />
                </div>
              )}
            </div>
            {open && (
              <aside aria-labelledby="partner-next-steps">
                <h2 id="partner-next-steps" className="text-sm font-semibold text-text">
                  What happens next
                </h2>
                <ol className="mt-6 space-y-6">
                  {NEXT_STEPS.map((step, i) => (
                    <li key={step.title} className="flex gap-4">
                      <span aria-hidden="true" className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-line bg-surface text-xs font-semibold text-brand">
                        {i + 1}
                      </span>
                      <div>
                        <p className="text-sm font-semibold text-text">{step.title}</p>
                        <p className="mt-1 text-sm leading-6 text-muted">{step.body}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              </aside>
            )}
          </div>
        </Container>
      </section>
    </>
  );
}
