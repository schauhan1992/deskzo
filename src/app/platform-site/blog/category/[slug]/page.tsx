import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ArchiveView, archiveMetadata, loadArchive } from "../../archive-view";

/**
 * A category's archive: its live posts and its children's, 12 a page (`?page=`), newest first, with
 * links to its subcategories. Unknown, nothing live, or a page past the last: the site's 404.
 */

export async function generateMetadata({ params, searchParams }: PageProps<"/platform-site/blog/category/[slug]">): Promise<Metadata> {
  return archiveMetadata(await loadArchive("category", (await params).slug, await searchParams));
}

export default async function CategoryArchivePage({ params, searchParams }: PageProps<"/platform-site/blog/category/[slug]">) {
  const archive = await loadArchive("category", (await params).slug, await searchParams);
  if (!archive) notFound();
  return <ArchiveView archive={archive} />;
}
