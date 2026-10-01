import Link from "next/link";
import { cn } from "@/lib/utils";

/** The mark on its own: the site name's first letter on the brand colour — the header's, and signup's while it works. */
export function SiteLogoMark({ name, className }: { name: string; className?: string }) {
  const initial = name.trim().charAt(0).toUpperCase() || "W";
  return (
    <span aria-hidden="true" className={cn("grid h-8 w-8 place-items-center rounded-lg bg-brand text-sm font-bold text-brand-contrast shadow-sm", className)}>
      {initial}
    </span>
  );
}

/** The site's name with a mark made from its first letter, in the brand colour — no image to replace. */
export function SiteLogo({ name, className }: { name: string; className?: string }) {
  return (
    <Link href="/" className={cn("flex shrink-0 items-center gap-2.5 rounded-md", className)}>
      <SiteLogoMark name={name} />
      <span className="text-[15px] font-semibold tracking-tight text-text">{name}</span>
    </Link>
  );
}
