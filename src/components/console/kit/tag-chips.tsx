import Link from "next/link";

const CHIP = "inline-flex h-5 max-w-48 items-center rounded-full border border-line bg-surface-sunken px-2 text-[11px] font-medium text-muted";

/** A workspace's tags; each links to the list filtered by it when the page passes an `href`. */
export function TagChips({ tags, empty }: { tags: { tag: string; href?: string }[]; empty?: string }) {
  if (tags.length === 0) return empty ? <span className="text-xs text-subtle">{empty}</span> : null;
  return (
    <ul aria-label="Tags" className="flex flex-wrap items-center gap-1">
      {tags.map((t, i) => (
        <li key={`${i}-${t.tag}`} className="inline-flex">
          {t.href ? (
            <Link href={t.href} className={`${CHIP} hover:border-line-strong hover:text-text`}>
              <span className="truncate">{t.tag}</span>
            </Link>
          ) : (
            <span className={CHIP}>
              <span className="truncate">{t.tag}</span>
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
