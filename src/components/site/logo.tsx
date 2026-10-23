import Link from "next/link";
import { cn } from "@/lib/utils";
import { DeskzoIcon, DeskzoWordmark } from "@/components/brand/deskzo-logo";

/**
 * The mark on its own: Deskzo's icon, the blue D on its white tile (owner, 23 Oct 2026) — signup's while it
 * works. `name` is what a screen reader hears.
 */
export function SiteLogoMark({ name, className }: { name: string; className?: string }) {
  return <DeskzoIcon title={name} className={cn("h-8 w-8 rounded-[22%] shadow-sm ring-1 ring-line", className)} />;
}

/** The site's logo: Deskzo's official wordmark — blue on a light page, white on a dark one — named by the site's name. */
export function SiteLogo({ name, className }: { name: string; className?: string }) {
  return (
    <Link href="/" aria-label={name} className={cn("flex shrink-0 items-center rounded-md", className)}>
      <DeskzoWordmark title={name} className="h-[22px]" />
    </Link>
  );
}
