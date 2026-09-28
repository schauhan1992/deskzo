import type { SiteMedia } from "@/components/site/blocks/types";
import { safeSrc } from "@/components/site/links";
import { ProductPreview } from "@/components/site/previews";
import { cn } from "@/lib/utils";

/** A block's picture: one of the drawn product previews, or an image from this site or an https address. */
export function MediaView({ media, framed = true, className }: { media: SiteMedia | undefined; framed?: boolean; className?: string }) {
  if (!media) return null;
  if (media.kind === "preview") return <ProductPreview kind={media.preview} framed={framed} className={className} />;
  const src = safeSrc(media.src);
  if (!src) return null;
  return (
    // An editor's image, from anywhere https: next/image would need each host configured in advance.
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={media.alt ?? ""} loading="lazy" className={cn("h-auto w-full rounded-2xl border border-line bg-surface object-cover shadow-lg", className)} />
  );
}
