import Link from "next/link";
import { cn } from "@/lib/utils";

export function TabNav({
  tabs,
  activeKey,
  paramName = "tab",
  basePath,
  otherParams = {},
}: {
  tabs: { key: string; label: string }[];
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
          </Link>
        );
      })}
    </div>
  );
}
