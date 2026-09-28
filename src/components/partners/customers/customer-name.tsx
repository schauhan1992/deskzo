import Link from "next/link";
import { PARTNER_ROUTES } from "@/lib/partners/nav";
import { cn } from "@/lib/utils";

/**
 * A customer's name, as a link to its page only when the view gave a slug — which it does only while
 * the workspace is this partner's customer now. Without one (a former customer on an old entry, a
 * reseller's customer) it is the name and nothing more: there is no page to open.
 *
 * Server-safe: no hooks, no directive; the client tables use it too.
 */
export function CustomerName({ slug, name, className }: { slug: string | null | undefined; name: string; className?: string }) {
  if (!slug) return <span className={cn("text-text", className)}>{name}</span>;
  return (
    <Link href={PARTNER_ROUTES.customer(slug)} className={cn("rounded-base font-medium text-text hover:text-brand hover:underline", className)}>
      {name}
    </Link>
  );
}
