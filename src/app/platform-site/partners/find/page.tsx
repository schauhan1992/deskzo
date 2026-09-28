import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { fill } from "@/components/site/links";
import { PartnerCountryFilter } from "@/components/site/partners/country-filter";
import { PartnerDirectoryCard } from "@/components/site/partners/directory-card";
import { applicationsShown, directoryShown, siteCopy } from "@/components/site/partners/programme";
import { ButtonLink, Container, Eyebrow } from "@/components/site/ui";
import { publicPartnerDirectory, type PublicPartner } from "@/lib/partners/registry";

/**
 * "Find a partner" (spec §10, D17): the ACTIVE partners that chose to be listed, optionally for one
 * country (`?country=`, offered only for countries a listed partner sells in). Off unless an owner
 * turns the directory on (partners.directory) — until then this is the site's 404. The five public
 * facts per partner, and no email address: the way to a partner is "Ask us to introduce you".
 */

const TITLE = "Find a partner";
const DESCRIPTION = "Companies that sell {siteName}, set it up and support it where you are.";

type Directory = { countries: { code: string; name: string }[]; partners: PublicPartner[] };

/** Every listed partner; none when the control plane can't answer (the page still renders). */
async function listed(): Promise<Directory> {
  try {
    return await publicPartnerDirectory(null);
  } catch (err) {
    console.warn(`[site] the partner directory is unavailable: ${(err as { code?: string } | null)?.code ?? (err instanceof Error ? err.name : "error")}`);
    return { countries: [], partners: [] };
  }
}

export async function generateMetadata(): Promise<Metadata> {
  const [ctx, shown] = await Promise.all([siteCopy(), directoryShown()]);
  if (!shown) return { title: fill(ctx.settings.notFound.heading, ctx), robots: { index: false, follow: false } };
  const description = fill(DESCRIPTION, ctx);
  return {
    title: TITLE,
    description,
    alternates: { canonical: "/partners/find" },
    openGraph: { type: "website", siteName: ctx.settings.siteName, title: TITLE, description, url: "/partners/find" },
    twitter: { card: "summary", title: TITLE, description },
  };
}

export default async function FindPartnerPage({ searchParams }: PageProps<"/platform-site/partners/find">) {
  if (!(await directoryShown())) notFound();
  const query = await searchParams;
  const asked = String((Array.isArray(query.country) ? query.country[0] : query.country) ?? "").trim().toUpperCase();
  const [ctx, directory, applying] = await Promise.all([siteCopy(), listed(), applicationsShown()]);
  // A country no listed partner sells in (or no country at all) shows everybody, so the filter and the list always agree.
  const country = directory.countries.find((c) => c.code === asked) ?? null;
  const partners = country ? directory.partners.filter((p) => p.territories.includes(country.code)) : directory.partners;

  return (
    <>
      <section className="relative overflow-hidden border-b border-line">
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_80%_at_0%_0%,color-mix(in_srgb,var(--brand)_10%,transparent),transparent_70%)]" />
        <Container className="relative py-14 sm:py-20">
          <div className="max-w-3xl">
            <Eyebrow>Partners</Eyebrow>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight text-text text-balance sm:text-5xl">{TITLE}</h1>
            <p className="mt-5 text-base leading-7 text-muted text-pretty sm:text-lg sm:leading-8">
              {fill("Companies that sell {siteName}, set it up and support it where you are. Choose a country to see who works there — or ask us to introduce you.", ctx)}
            </p>
          </div>
        </Container>
      </section>

      <section className="py-12 sm:py-16">
        <Container>
          {partners.length ? (
            <>
              <div className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between sm:p-5">
                <PartnerCountryFilter countries={directory.countries} value={country?.code ?? ""} />
                <p className="text-sm text-muted">
                  {`${partners.length} ${partners.length === 1 ? "partner" : "partners"}${country ? ` in ${country.name}` : ""}`}
                </p>
              </div>
              <ul className="mt-8 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
                {partners.map((partner, i) => (
                  <PartnerDirectoryCard key={`${partner.displayName}-${i}`} partner={partner} />
                ))}
              </ul>
            </>
          ) : (
            <div className="rounded-2xl border border-dashed border-line-strong bg-surface-sunken px-6 py-14 text-center">
              <h2 className="text-xl font-semibold text-text">No partners are listed yet.</h2>
              <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-muted">Tell us where you are and what you need, and we will put you in touch with the right people.</p>
              <ButtonLink href="/contact?topic=sales" label="Ask us to introduce you" className="mt-6" arrow />
            </div>
          )}

          {applying && (
            <div className="mt-16 flex flex-col items-start gap-4 rounded-2xl border border-line bg-surface p-6 shadow-sm sm:flex-row sm:items-center sm:justify-between sm:p-8">
              <div>
                <h2 className="text-lg font-semibold text-text">{fill("Sell {siteName} yourself?", ctx)}</h2>
                <p className="mt-1 text-sm leading-6 text-muted">Join the partner programme and earn a recurring commission on your customers.</p>
              </div>
              <ButtonLink href="/partners" label="Become a partner" tone="secondary" arrow />
            </div>
          )}
        </Container>
      </section>
    </>
  );
}
