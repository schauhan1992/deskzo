import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ArchiveView, archiveJsonLd, archiveMetadata, loadArchive } from "../../archive-view";

/** A tag's archive: its live posts, 12 a page (`?page=`), newest first. Unknown, nothing live, or a page past the last: the site's 404. */

export async function generateMetadata({ params, searchParams }: PageProps<"/platform-site/blog/tag/[slug]">): Promise<Metadata> {
  return archiveMetadata(await loadArchive("tag", (await params).slug, await searchParams));
}

export default async function TagArchivePage({ params, searchParams }: PageProps<"/platform-site/blog/tag/[slug]">) {
  const archive = await loadArchive("tag", (await params).slug, await searchParams);
  if (!archive) notFound();
  return <ArchiveView archive={archive} jsonLd={await archiveJsonLd(archive)} />;
}
