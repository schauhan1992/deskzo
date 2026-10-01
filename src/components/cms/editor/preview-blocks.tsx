"use client";

import { Component, type ReactNode } from "react";
import { ArrowLeft, Check, Globe } from "lucide-react";
import type { PricingTableProps, SiteBlock, SiteRenderContext } from "@/components/site/blocks/types";
import { ContactFormBlock } from "@/components/site/blocks/contact-form";
import { ComparisonTableBlock } from "@/components/site/blocks/comparison-table";
import { CtaBlock } from "@/components/site/blocks/cta";
import { FaqBlock } from "@/components/site/blocks/faq";
import { FeatureGridBlock } from "@/components/site/blocks/feature-grid";
import { HeroBlock } from "@/components/site/blocks/hero";
import { ImageTextBlock } from "@/components/site/blocks/image-text";
import { LogoCloudBlock } from "@/components/site/blocks/logo-cloud";
import { ModuleGridBlock } from "@/components/site/blocks/module-grid";
import { ModuleHighlightsBlock } from "@/components/site/blocks/module-highlights";
import { PageHeaderBlock } from "@/components/site/blocks/page-header";
import { ProductPreviewsBlock } from "@/components/site/blocks/product-previews";
import { RelatedLinksBlock } from "@/components/site/blocks/related-links";
import { RichTextBlock } from "@/components/site/blocks/rich-text";
import { SecurityHighlightsBlock } from "@/components/site/blocks/security-highlights";
import { SignupFormBlock } from "@/components/site/blocks/signup-form";
import { StatsBlock } from "@/components/site/blocks/stats";
import { TestimonialBlock } from "@/components/site/blocks/testimonial";
import { WorkspaceSigninBlock } from "@/components/site/blocks/workspace-signin";
import { SiteFooter } from "@/components/site/footer";
import { SiteHeader } from "@/components/site/header";
import { anchorId, fill, resolveAction, safeSrc } from "@/components/site/links";
import { fillNav } from "@/components/site/nav";
import { Container } from "@/components/site/ui";
import { BLOCK_INFO } from "@/components/cms/editor/catalog";
import { cn } from "@/lib/utils";

/**
 * The live preview's content: the unsaved blocks rendered by the public site's own block components
 * (src/components/site/blocks/*), inside the site's own header and footer — so what an editor sees is
 * what the site will show, with the tokens ({siteName}, {trialDays}…) filled from the live settings.
 *
 * Two differences, both said on screen: the pricing table's plans are live data read on the server,
 * so the preview shows the words around a placeholder for them; and nothing in the preview can be
 * clicked through (it is `inert`) — a click picks the block in the editor instead.
 */

type BoundaryProps = { resetKey: unknown; label: string; children: ReactNode };

/** One broken block (half-typed content the renderer did not expect) must not blank the preview. */
class BlockBoundary extends Component<BoundaryProps, { failed: boolean; key: unknown }> {
  state = { failed: false, key: this.props.resetKey };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  static getDerivedStateFromProps(props: BoundaryProps, state: { failed: boolean; key: unknown }) {
    return props.resetKey !== state.key ? { failed: false, key: props.resetKey } : null;
  }
  render() {
    if (this.state.failed) {
      return (
        <Container className="py-8">
          <p className="rounded-lg border border-dashed border-warning/50 bg-warning-bg px-4 py-3 text-sm text-warning">{this.props.label} can&apos;t be drawn with what it holds yet — keep editing.</p>
        </Container>
      );
    }
    return this.props.children;
  }
}

function PricingPlaceholder({ props, ctx }: { props: PricingTableProps; ctx: SiteRenderContext }) {
  const t = (s?: string) => fill(s, ctx);
  const empty = resolveAction(props.emptyAction ?? { kind: "signup" }, ctx);
  return (
    <section id={anchorId(props.anchor)} className="py-12 sm:py-16">
      <Container>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h2 className="text-2xl font-semibold tracking-tight text-text">{t(props.editionsHeading)}</h2>
          <p className="inline-flex items-center gap-2 text-sm text-muted">
            <Globe aria-hidden="true" className="h-4 w-4" />
            {t(props.countryLabel)} <span className="rounded-base border border-line-strong bg-surface px-2 py-1 text-text">India</span>
          </p>
        </div>
        <div className="mt-8 grid gap-6 md:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded-2xl border border-dashed border-line-strong bg-surface p-6">
              <div className="h-4 w-24 rounded bg-surface-sunken" />
              <div className="mt-4 h-8 w-32 rounded bg-surface-sunken" />
              <ul className="mt-6 space-y-3">
                {[0, 1, 2, 3].map((j) => (
                  <li key={j} className="flex items-center gap-2">
                    <Check aria-hidden="true" className="h-4 w-4 text-subtle" />
                    <span className="h-3 w-40 max-w-full rounded bg-surface-sunken" />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <p className="mt-4 rounded-lg border border-info/30 bg-info-bg px-4 py-2 text-center text-xs text-info">
          Plans and prices appear here live from the platform. Use Preview to see them with this page.
        </p>
        {props.trialNote && <p className="mt-6 text-center text-sm text-muted">{t(props.trialNote)}</p>}
        {props.footnote && <p className="mt-2 text-center text-sm text-muted">{t(props.footnote)}</p>}
        <div className="mt-14">
          <h2 className="text-xl font-semibold text-text">{t(props.extrasHeading)}</h2>
          {props.extrasIntro && <p className="mt-2 max-w-2xl text-sm text-muted">{t(props.extrasIntro)}</p>}
        </div>
        <div className="mt-10 rounded-2xl border border-line bg-surface-sunken p-6 text-center">
          <p className="text-xs font-medium tracking-wide text-subtle uppercase">Shown where nothing is on sale</p>
          <p className="mt-2 font-semibold text-text">{t(props.emptyHeading)}</p>
          <p className="mt-1 text-sm text-muted">{t(props.emptyBody)}</p>
          {props.emptyAction && <p className="mt-3 text-sm font-medium text-brand">{empty.label}</p>}
        </div>
      </Container>
    </section>
  );
}

function renderBlock(block: SiteBlock, ctx: SiteRenderContext): ReactNode {
  switch (block.type) {
    case "hero":
      return <HeroBlock props={block.props} ctx={ctx} />;
    case "pageHeader":
      return <PageHeaderBlock props={block.props} ctx={ctx} />;
    case "featureGrid":
      return <FeatureGridBlock props={block.props} ctx={ctx} />;
    case "moduleGrid":
      return <ModuleGridBlock props={block.props} ctx={ctx} />;
    case "richText":
      return <RichTextBlock props={block.props} ctx={ctx} />;
    case "imageText":
      return <ImageTextBlock props={block.props} ctx={ctx} />;
    case "stats":
      return <StatsBlock props={block.props} ctx={ctx} />;
    case "faq":
      return <FaqBlock props={block.props} ctx={ctx} />;
    case "cta":
      return <CtaBlock props={block.props} ctx={ctx} />;
    case "pricingTable":
      return <PricingPlaceholder props={block.props} ctx={ctx} />;
    case "securityHighlights":
      return <SecurityHighlightsBlock props={block.props} ctx={ctx} />;
    case "contactForm":
      return <ContactFormBlock props={block.props} ctx={ctx} />;
    case "logoCloud":
      return <LogoCloudBlock props={block.props} ctx={ctx} />;
    case "testimonial":
      return <TestimonialBlock props={block.props} ctx={ctx} />;
    case "productPreviews":
      return <ProductPreviewsBlock props={block.props} ctx={ctx} />;
    case "workspaceSignin":
      return <WorkspaceSigninBlock props={block.props} ctx={ctx} />;
    case "signupForm":
      return <SignupFormBlock props={block.props} ctx={ctx} />;
    case "comparisonTable":
      return <ComparisonTableBlock props={block.props} ctx={ctx} />;
    case "relatedLinks":
      return <RelatedLinksBlock props={block.props} ctx={ctx} />;
    case "moduleHighlights":
      return <ModuleHighlightsBlock props={block.props} ctx={ctx} />;
    default:
      return null;
  }
}

/** The blocks, each marked with its id so a click in the preview can pick it in the editor. */
export function PreviewBlocks({ blocks, ctx, activeId }: { blocks: SiteBlock[]; ctx: SiteRenderContext; activeId: string | null }) {
  if (blocks.length === 0) {
    return (
      <Container className="py-24 text-center">
        <p className="text-sm text-muted">No blocks yet. Add one to see it here.</p>
      </Container>
    );
  }
  return (
    <>
      {blocks.map((block) => (
        <div
          key={block.id}
          data-block-id={block.id}
          title={`${BLOCK_INFO[block.type]?.label ?? "Block"} — click to edit`}
          className={cn(
            "relative cursor-pointer outline-offset-[-3px] transition-[outline-color] hover:outline-2 hover:outline-dashed hover:outline-brand/50",
            activeId === block.id && "outline-2 outline-brand outline-solid hover:outline-solid hover:outline-brand",
          )}
        >
          <div inert>
            <BlockBoundary resetKey={block} label={BLOCK_INFO[block.type]?.label ?? "This block"}>
              {renderBlock(block, ctx)}
            </BlockBoundary>
          </div>
        </div>
      ))}
    </>
  );
}

/** The site's header and footer around the preview, as the live settings draw them. */
export function PreviewChrome({ ctx, year, show, children }: { ctx: SiteRenderContext; year: number; show: boolean; children: ReactNode }) {
  if (!show) return <main>{children}</main>;
  const { settings } = ctx;
  const cta = resolveAction({ kind: "signup" }, ctx);
  return (
    <div className="flex min-h-screen flex-col bg-bg text-text">
      <div inert>
        <SiteHeader siteName={settings.siteName} nav={fillNav(settings.nav, ctx)} signin={{ label: fill(settings.signinLink.label, ctx), href: settings.signinLink.href }} cta={cta} />
      </div>
      <main className="flex-1">{children}</main>
      <div inert>
        <SiteFooter ctx={ctx} year={year} />
      </div>
    </div>
  );
}

/** A post's header and cover, laid out as the blog's article is (src/app/platform-site/blog/post-article.tsx). */
export function PreviewPostHeader({
  title,
  excerpt,
  tags,
  author,
  dateLabel,
  cover,
}: {
  title: string;
  excerpt: string | null;
  tags: string[];
  author: string;
  dateLabel: string;
  cover: { src: string; alt: string } | null;
}) {
  const src = cover ? safeSrc(cover.src) : null;
  return (
    <div inert>
      <header className="border-b border-line">
        <Container className="py-12 sm:py-16">
          <div className="mx-auto max-w-3xl">
            <span className="inline-flex items-center gap-1.5 text-sm font-medium text-muted">
              <ArrowLeft aria-hidden="true" className="h-4 w-4" />
              All posts
            </span>
            <h1 className="mt-6 text-4xl font-semibold tracking-tight text-text text-balance sm:text-5xl">{title || "Untitled post"}</h1>
            {excerpt && <p className="mt-5 text-lg leading-8 text-muted text-pretty">{excerpt}</p>}
            <p className="mt-6 text-sm text-subtle">
              {dateLabel}
              <span aria-hidden="true"> · </span>
              {author}
            </p>
            {tags.length > 0 && (
              <ul className="mt-4 flex flex-wrap gap-2">
                {tags.map((tag) => (
                  <li key={tag} className="inline-flex rounded-full border border-line bg-surface px-2.5 py-0.5 text-xs font-medium text-muted">
                    #{tag}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Container>
      </header>
      {src && (
        <Container className="pt-10">
          {/* A library image, served by /media on this host. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt={cover?.alt ?? ""} className="mx-auto h-auto w-full max-w-4xl rounded-2xl border border-line bg-surface-sunken object-cover shadow-sm" />
        </Container>
      )}
    </div>
  );
}
