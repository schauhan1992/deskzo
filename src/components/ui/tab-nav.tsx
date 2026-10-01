import Link from "next/link";
import { cn } from "@/lib/utils";

export function TabNav({
  tabs,
  activeKey,
  paramName = "tab",
  basePath,
  otherParams = {},
}: {
  /** `count`, when given, is a badge beside the label, read out as "Staff, 3". */
  tabs: { key: string; label: string; count?: number }[];
  activeKey: string;
  paramName?: string;
  basePath: string;
  otherParams?: Record<string, string | undefined>;
}) {
  const baseQuery = Object.fromEntries(Object.entries(otherParams).filter(([, v]) => v)) as Record<string, string>;
  const defaultKey = tabs[0]?.key;

  return (
    <div className="flex flex-wrap gap-x-1 border-b border-line">
      {tabs.map((t) => {
        const query = t.key === defaultKey ? baseQuery : { ...baseQuery, [paramName]: t.key };
        const active = activeKey === t.key;
        return (
          <Link
            key={t.key}
            href={{ pathname: basePath, query }}
            className={cn(
              "-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium",
              active ? "border-brand text-text" : "border-transparent text-muted hover:text-text",
            )}
          >
            {t.label}
            {t.count !== undefined && (
              <>
                {/* The comma is for a screen reader, so the badge is not run into the word before it. */}
                <span className="sr-only">, </span>
                <span
                  className={cn(
                    "ml-1.5 inline-flex min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold leading-5 tabular-nums",
                    active ? "bg-brand-subtle text-brand" : "bg-surface-sunken text-muted",
                  )}
                >
                  {t.count}
                </span>
              </>
            )}
          </Link>
        );
      })}
    </div>
  );
}
