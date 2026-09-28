import Link from "next/link";
import { cn } from "@/lib/utils";

/** The site's name with a mark made from its first letter, in the brand colour — no image to replace. */
export function SiteLogo({ name, className }: { name: string; className?: string }) {
  const initial = name.trim().charAt(0).toUpperCase() || "W";
  return (
    <Link href="/" className={cn("flex shrink-0 items-center gap-2.5 rounded-md", className)}>
      <span aria-hidden="true" className="grid h-8 w-8 place-items-center rounded-lg bg-brand text-sm font-bold text-brand-contrast shadow-sm">
        {initial}
      </span>
      <span className="text-[15px] font-semibold tracking-tight text-text">{name}</span>
    </Link>
  );
}
