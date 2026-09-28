import type { Metadata } from "next";
import type { ReactNode } from "react";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import type { SiteRenderContext } from "@/components/site/blocks/types";
import { SiteBlocks } from "@/components/site/blocks/render";
import { SiteFooter } from "@/components/site/footer";
import { SiteHeader } from "@/components/site/header";
import { fill, resolveAction, safeSrc } from "@/components/site/links";
import { ButtonLink, Container } from "@/components/site/ui";
import { istDateParts } from "@/lib/india-time";
import { getSitePage, getSiteSettings, sitePath, siteStatus, workspaceSuffix } from "@/lib/platform/site-content";
import { HOST_MISMATCH, protocolFor, requestHost } from "@/lib/tenancy/host";

/**
 * How a page of the public site is put together: its content from the one loader
 * (src/lib/platform/site-content.ts), rendered as blocks (./blocks) inside the site's header and
 * footer. The routes in src/app/platform-site are one line each on top of this.
 */

type Query = Record<string, string | string[] | undefined>;

function firstValues(query: Query): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(query).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
}

async function renderContext(query: Query = {}): Promise<SiteRenderContext> {
  const [settings, status] = await Promise.all([getSiteSettings(), siteStatus()]);
  return { settings, signupOpen: status.signupOpen, trialDays: status.trialDays, searchParams: firstValues(query), workspaceSuffix: workspaceSuffix() };
}

/** The year in India, on the server — never a client's clock. */
function thisYear(): number {
  return istDateParts(new Date()).year;
}

/** The site's frame: header, main, footer. */
export async function SiteShell({ children }: { children: ReactNode }) {
  const ctx = await renderContext();
  const { settings } = ctx;
  const cta = resolveAction({ kind: "signup" }, ctx);
  return (
    <div className="flex min-h-screen flex-col bg-bg text-text">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-base focus:bg-surface focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-text focus:shadow-md">
        Skip to content
      </a>
      <SiteHeader
        siteName={settings.siteName}
        nav={settings.nav.map((l) => ({ label: fill(l.label, ctx), href: l.href }))}
        signin={{ label: fill(settings.signinLink.label, ctx), href: settings.signinLink.href }}
        cta={cta}
      />
      <main id="main" className="flex-1">
        {children}
      </main>
      <SiteFooter ctx={ctx} year={thisYear()} />
    </div>
  );
}

/** The query keys the signup form block reads its "Referred by" line from. */
const REFERRAL_KEYS = ["ref", "refVia", "refName"] as const;

/**
 * A page's blocks; an address the site has no page for is the site's not-found page.
 *
 * The referral keys are dropped from every query unless the caller says it checked them: a signup form
 * block on any page shows `refName` as "Referred by …", and a hand-made link must not put words of
 * its own there on the platform's site. Only the signup page, which looks the code up and writes all
 * three itself, passes `trustedReferral`.
 */
export async function SitePageView({ slug, searchParams, trustedReferral = false }: { slug: string; searchParams?: Query; trustedReferral?: boolean }) {
  const query = trustedReferral || !searchParams ? searchParams : Object.fromEntries(Object.entries(searchParams).filter(([key]) => !(REFERRAL_KEYS as readonly string[]).includes(key)));
  const [page, ctx] = await Promise.all([getSitePage(slug), renderContext(query)]);
  if (!page) notFound();
  return <SiteBlocks blocks={page.blocks} ctx={ctx} />;
}

/** The not-found page's words, from the site's settings. */
export async function SiteNotFoundView() {
  const ctx = await renderContext();
  const { notFound: content } = ctx.settings;
  return (
    <section className="py-24 sm:py-32">
      <Container>
        <div className="mx-auto max-w-xl text-center">
          <p className="text-sm font-semibold text-brand">404</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight text-text text-balance sm:text-5xl">{fill(content.heading, ctx)}</h1>
          <p className="mt-5 text-base leading-7 text-muted">{fill(content.body, ctx)}</p>
          <div className="mt-10 flex flex-wrap justify-center gap-3">
            {content.links.map((link, i) => (
              <ButtonLink key={i} href={link.href} label={fill(link.label, ctx)} tone={i === 0 ? "primary" : "secondary"} />
            ))}
          </div>
        </div>
      </Container>
    </section>
  );
}

/** The origin this request came in on (the bare domain or www.), for absolute URLs in metadata. */
async function requestOrigin(): Promise<URL | undefined> {
  try {
    const host = requestHost(await headers());
    return host && host !== HOST_MISMATCH ? new URL(`${protocolFor(host)}://${host}`) : undefined;
  } catch {
    return undefined;
  }
}

/** The site's title template, description and Open Graph defaults — the layout's metadata. */
export async function siteLayoutMetadata(): Promise<Metadata> {
  const [ctx, origin] = await Promise.all([renderContext(), requestOrigin()]);
  const { settings } = ctx;
  const image = safeSrc(settings.seo.ogImage);
  return {
    metadataBase: origin,
    title: { template: fill(settings.seo.titleTemplate, ctx), default: fill(settings.seo.defaultTitle, ctx) },
    description: fill(settings.seo.description, ctx),
    applicationName: settings.siteName,
    openGraph: { type: "website", siteName: settings.siteName, images: image ? [image] : undefined },
  };
}

/** A page's title, description, Open Graph and canonical address; kept out of search engines when its content says so. */
export async function sitePageMetadata(slug: string): Promise<Metadata> {
  const [page, ctx] = await Promise.all([getSitePage(slug), renderContext()]);
  if (!page) return { title: fill(ctx.settings.notFound.heading, ctx), robots: { index: false, follow: false } };
  const title = fill(page.seo.title, ctx);
  const description = fill(page.seo.description, ctx);
  const image = safeSrc(page.seo.ogImage ?? ctx.settings.seo.ogImage);
  const path = sitePath(page.slug);
  return {
    title: page.seo.absoluteTitle ? { absolute: title } : title,
    description,
    alternates: { canonical: path },
    openGraph: {
      type: "website",
      siteName: ctx.settings.siteName,
      title: fill(page.seo.ogTitle, ctx) || title,
      description: fill(page.seo.ogDescription, ctx) || description,
      url: path,
      images: image ? [image] : undefined,
    },
    twitter: { card: image ? "summary_large_image" : "summary", title, description },
    robots: page.seo.noindex ? { index: false, follow: false } : undefined,
  };
}
