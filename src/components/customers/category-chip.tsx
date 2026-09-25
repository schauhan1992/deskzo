import { Tag, type LucideProps } from "lucide-react";
import { CATEGORY_ICONS } from "@/lib/customers/category-icons";
import { resolveCategory, type CategoryWithParent } from "@/lib/customers/categories";
import { cn } from "@/lib/utils";

/**
 * A customer's category, beside their name — so whoever is looking knows who this is before they
 * read anything else. Every one renders nothing for a customer with no category.
 *
 * No hooks, so a server page and a client table can both use them.
 */

type Category = CategoryWithParent | null | undefined;

/** A category's icon, by the key stored on it. A key the set no longer has shows a tag. */
export function CategoryGlyph({ icon, ...props }: { icon: string | null | undefined } & LucideProps) {
  const Icon = CATEGORY_ICONS[icon ?? ""]?.Icon ?? Tag;
  return <Icon {...props} />;
}

/** "⭐ Strategic › Key account". Hover for the handling note. */
export function CategoryChip({ category, size = "sm", className }: { category: Category; size?: "sm" | "md"; className?: string }) {
  const c = resolveCategory(category);
  if (!c) return null;
  return (
    <span
      title={c.guidance.length ? `${c.label} — ${c.guidance.join(" ")}` : c.label}
      data-category={c.id}
      className={cn(
        "inline-flex max-w-full items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 font-medium leading-5",
        size === "md" ? "text-xs" : "text-[11px]",
        className,
      )}
      style={{ color: c.color, backgroundColor: `${c.color}14`, borderColor: `${c.color}40` }}
    >
      <CategoryGlyph icon={c.icon} className={size === "md" ? "h-3.5 w-3.5 shrink-0" : "h-3 w-3 shrink-0"} aria-hidden />
      <span className="truncate">{c.label}</span>
    </span>
  );
}

/** Just the icon, in its colour — for a table row or a picker, where the name is already beside it. */
export function CategoryIcon({ category, className }: { category: Category; className?: string }) {
  const c = resolveCategory(category);
  if (!c) return null;
  return (
    <span
      role="img"
      aria-label={c.label}
      title={c.label}
      data-category={c.id}
      className={cn("inline-grid h-5 w-5 shrink-0 place-items-center rounded-full", className)}
      style={{ color: c.color, backgroundColor: `${c.color}1f` }}
    >
      <CategoryGlyph icon={c.icon} className="h-3 w-3" aria-hidden />
    </span>
  );
}

/** How to treat them — under the name on the customer's own page. Nothing when no note is written. */
export function CategoryGuidance({ category, className }: { category: Category; className?: string }) {
  const c = resolveCategory(category);
  if (!c || c.guidance.length === 0) return null;
  return (
    <div
      className={cn("flex gap-2.5 rounded-lg border px-3 py-2 text-sm", className)}
      style={{ borderColor: `${c.color}40`, backgroundColor: `${c.color}0d` }}
    >
      <CategoryGlyph icon={c.icon} className="mt-0.5 h-4 w-4 shrink-0" style={{ color: c.color }} aria-hidden />
      <div className="min-w-0 space-y-0.5">
        <div className="text-xs font-semibold" style={{ color: c.color }}>
          How to treat them — {c.label}
        </div>
        {c.guidance.map((g, i) => (
          <p key={i} className="text-text">
            {g}
          </p>
        ))}
      </div>
    </div>
  );
}
