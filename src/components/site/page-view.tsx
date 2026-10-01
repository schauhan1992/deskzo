import type { Metadata } from "next";
import type { ReactNode } from "react";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import type { SiteRenderContext } from "@/components/site/blocks/types";
import { SiteBlocks } from "@/components/site/blocks/render";
import { SiteFooter } from "@/components/site/footer";
import { SiteHeader } from "@/components/site/header";
import { fill, resolveAction } from "@/components/site/links";
import { fillNav } from "@/components/site/nav";
import { applicationsShown, directoryShown } from "@/components/site/partners/programme";
import { Breadcrumbs, ButtonLink, Container } from "@/components/site/ui";
import { istDateParts } from "@/lib/india-time";
import { getSitePage, getSiteSettings, sitePath, siteStatus, workspaceSuffix } from "@/lib/platform/site-content";
import { aiSearchCrawlersAllowed } from "@/lib/seo/crawlers";
import { inputFromPage, siteContextFrom } from "@/lib/seo/extract";
import { buildLayoutMetadata, buildPageMetadata } from "@/lib/seo/metadata";
import { serialiseLd } from "@/lib/seo/schema";
import type { JsonLd, SeoInput, SeoSiteContext } from "@/lib/seo/types";
import { HOST_MISMATCH, protocolFor, requestHost } from "@/lib/tenancy/host";

/**
 * How a page of the public site is put together: its content from the one loader
 * (src/lib/platform/site-content.ts), rendered as blocks (./blocks) inside the site's header and
 * footer. The routes in src/app/platform-site are one line each on top of this.
 *
 * Metadata and structured data come from the SEO engine's pure builders (src/lib/seo): the same
 * code the CMS's score panels read, so what they score is what the site emits. Only the builders run
 * here — never a score.
 */

type Query = Record<string, string | string[] | undefined>;

function firstValues(query: Query): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(query).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
}

async function renderContext(query: Query = {}): Promise<SiteRenderContext> {
  const [settings, status, applying, directory] = await Promise.all([getSiteSettings(), siteStatus(), applicationsShown(), directoryShown()]);
  // The partner programme's pages answer "not found" while their switch is off; nothing links there.
  const hiddenPaths = [...(applying ? [] : ["/partners"]), ...(directory ? [] : ["/partners/find"])];
  return { settings, signupOpen: status.signupOpen, trialDays: status.trialDays, searchParams: firstValues(query), workspaceSuffix: workspaceSuffix(), hiddenPaths };
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
        nav={fillNav(settings.nav, ctx)}
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
 * A page's blocks, and its structured data; an address the site has no page for is the site's
 * not-found page.
 *
 * The referral keys are dropped from every query unless the caller says it checked them: a signup form
 * block on any page shows `refName` as "Referred by …", and a hand-made link must not put words of
 * its own there on the platform's site. Only the signup page, which looks the code up and writes all
 * three itself, passes `trustedReferral`.
 */
export async function SitePageView({ slug, searchParams, trustedReferral = false }: { slug: string; searchParams?: Query; trustedReferral?: boolean }) {
  const query = trustedReferral || !searchParams ? searchParams : Object.fromEntries(Object.entries(searchParams).filter(([key]) => !(REFERRAL_KEYS as readonly string[]).includes(key)));
  const [page, ctx, origin, parents] = await Promise.all([getSitePage(slug), renderContext(query), requestOrigin(), pageParents(slug)]);
  if (!page) notFound();
  const nested = slug.includes("/");
  return (
    <>
      <JsonLdScript data={jsonLdOf(() => inputFromPage({ ...page, parents }, seoSiteContext(ctx, origin), new Date()))} />
      {nested && (
        <div className="border-b border-line">
          <Container className="py-3">
            <Breadcrumbs trail={[{ name: "Home", href: "/" }, ...parents.map((p) => ({ name: p.name, href: p.path }))]} current={fill(page.title, ctx)} />
          </Container>
        </div>
      )}
      <SiteBlocks blocks={page.blocks} ctx={ctx} />
    </>
  );
}

/**
 * The pages above a nested page — for "product/crm", the page at "product" — each by its title,
 * tokens filled. A level the site has no page for is left out: a breadcrumb never links to a
 * not-found. Read from the same cached pages as the page itself, so it costs no query.
 */
export async function pageParents(slug: string): Promise<{ name: string; path: string }[]> {
  const segments = slug.split("/");
  if (segments.length < 2) return [];
  const [settings, status] = await Promise.all([getSiteSettings(), siteStatus()]);
  const found = await Promise.all(segments.slice(0, -1).map((_, i) => getSitePage(segments.slice(0, i + 1).join("/"))));
  return found.flatMap((page) => (page && page.slug !== "home" ? [{ name: fill(page.title, { settings, trialDays: status.trialDays }), path: sitePath(page.slug) }] : []));
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

/** The origin this request came in on (the bare domain or www.), for absolute URLs in metadata and structured data. */
export async function requestOrigin(): Promise<URL | undefined> {
  try {
    const host = requestHost(await headers());
    return host && host !== HOST_MISMATCH ? new URL(`${protocolFor(host)}://${host}`) : undefined;
  } catch {
    return undefined;
  }
}

// ─── Metadata ────────────────────────────────────────────────────────────────────────────────────

/**
 * The builders' metadata as the site sends it. Next writes an array of keywords joined by bare
 * commas ("a,b,c"); one string keeps the owner's "a, b, c". An entity without keywords has no
 * `keywords` at all, so no tag — and its object is exactly the builder's.
 */
export function joinKeywords(metadata: Metadata): Metadata {
  return Array.isArray(metadata.keywords) && metadata.keywords.length ? { ...metadata, keywords: metadata.keywords.join(", ") } : metadata;
}

/** The site's title template, description and Open Graph defaults — the layout's metadata. */
export async function siteLayoutMetadata(): Promise<Metadata> {
  const [ctx, origin] = await Promise.all([renderContext(), requestOrigin()]);
  return buildLayoutMetadata(ctx, origin);
}

/** A page's title, description, keywords, Open Graph and canonical address; kept out of search engines when its content says so. */
export async function sitePageMetadata(slug: string): Promise<Metadata> {
  const [page, ctx] = await Promise.all([getSitePage(slug), renderContext()]);
  return joinKeywords(buildPageMetadata(page, ctx));
}

// ─── Structured data (owner decision S-D1) ───────────────────────────────────────────────────────

/**
 * The site around a page, post or archive, for its structured data: the settings and platform status
 * the page has already read, and the address this request came in on (JSON-LD's URLs are absolute).
 */
export function seoSiteContext(ctx: Pick<SiteRenderContext, "settings" | "signupOpen" | "trialDays">, origin: URL | undefined): SeoSiteContext {
  return siteContextFrom(ctx.settings, { trialDays: ctx.trialDays, signupOpen: ctx.signupOpen, origin: origin?.origin ?? "", aiSearchCrawlersAllowed: aiSearchCrawlersAllowed() });
}

/**
 * An entity's JSON-LD, from the same `SeoInput` the SEO engine scores (src/lib/seo/extract.ts and
 * schema.ts). Structured data is an extra: should building it ever fail, the page goes out without it
 * rather than not at all.
 */
export function jsonLdOf(build: () => SeoInput): JsonLd[] {
  try {
    return build().jsonLd;
  } catch (err) {
    console.warn(`[site] structured data left out of a page: ${err instanceof Error ? err.name : "error"}`);
    return [];
  }
}

/**
 * A page's structured data as one `<script type="application/ld+json">` in the body: every object
 * in one array. `serialiseLd` escapes `<`, `>` and `&`, so no text in it — a title with
 * "</script>" in it — can close the element. Nothing at all when there is none (the blog index).
 */
export function JsonLdScript({ data }: { data: readonly JsonLd[] }) {
  if (!data.length) return null;
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serialiseLd(data) }} />;
}
