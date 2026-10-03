import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Eye } from "lucide-react";
import { SiteBlocks } from "@/components/site/blocks/render";
import { Container } from "@/components/site/ui";
import { loadPreview } from "@/lib/cms/preview";
import { consoleClock } from "@/lib/platform/console-clock";
import { PostArticle, blogContext } from "../../blog/post-article";

/**
 * A draft, as it would look published — opened from the CMS's "Preview" with a signed, 15-minute token
 * (src/lib/cms/preview.ts). Never indexed, never cached (the proxy sends no-store for /preview), and
 * marked at the top so nobody mistakes it for the live page. A forged token is the site's 404; an
 * expired one, or one for a draft saved since, says so. The link's end is told on the CMS's clock —
 * the console's (Settings › Time zone) — with the zone named, since this page is outside the CMS.
 */

export const metadata: Metadata = { title: "Preview", robots: { index: false, follow: false, nocache: true } };

const REASONS = {
  expired: { heading: "This preview has expired", body: "Preview links last fifteen minutes. Open Preview again from the CMS." },
  stale: { heading: "This draft has changed", body: "The draft was saved again after this link was made. Open Preview again from the CMS to see the latest." },
  gone: { heading: "This draft no longer exists", body: "It may have been deleted. Nothing is published at this link." },
} as const;

export default async function PreviewPage({ params }: PageProps<"/platform-site/preview/[token]">) {
  await connection();
  const preview = await loadPreview((await params).token);
  if (!preview.ok) {
    if (preview.reason === "invalid") notFound();
    const reason = REASONS[preview.reason];
    return (
      <section className="py-24 sm:py-32">
        <Container>
          <div className="mx-auto max-w-xl text-center">
            <p className="text-sm font-semibold text-brand">Preview</p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-text text-balance">{reason.heading}</h1>
            <p className="mt-4 text-base leading-7 text-muted">{reason.body}</p>
          </div>
        </Container>
      </section>
    );
  }
  const [ctx, clock] = await Promise.all([blogContext(), consoleClock()]);
  return (
    <>
      <div role="status" className="sticky top-0 z-40 border-b border-warning/30 bg-warning-bg text-warning">
        <Container className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
          <p className="flex items-center gap-2 font-semibold">
            <Eye aria-hidden="true" className="h-4 w-4" />
            Preview — not published
          </p>
          <p className="text-xs">{`This link stops working at ${clock.time(preview.expiresAt)} (${clock.zone.replace(/_/g, " ")} time).`}</p>
        </Container>
      </div>
      {preview.kind === "page" ? <SiteBlocks blocks={preview.page.blocks} ctx={ctx} /> : <PostArticle post={preview.post} ctx={ctx} />}
    </>
  );
}
