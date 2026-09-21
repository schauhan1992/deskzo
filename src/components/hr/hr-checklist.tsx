import Link from "next/link";
import { AlertTriangle, Check, Circle } from "lucide-react";
import type { ChecklistItem } from "@/lib/hr/onboarding";
import { completeness } from "@/lib/hr/onboarding";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";

/**
 * What is still outstanding for somebody joining or leaving.
 *
 * Blocking items are separated visually rather than just ordered first, because the distinction is
 * not "more important" — it is "this will actively go wrong". Payroll silently skipping somebody
 * with no salary structure, or an ex-employee keeping a working login, are different in kind from
 * a missing blood group.
 */
export function HrChecklist({
  title,
  items,
  subtitle,
}: {
  title: string;
  items: ChecklistItem[];
  subtitle?: string;
}) {
  const done = items.filter((i) => i.done).length;
  const percent = completeness(items);
  const blocking = items.filter((i) => !i.done && i.blocking);

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium text-text">
        <span>{title}</span>
        <span className="flex items-center gap-2">
          {blocking.length > 0 && (
            <Badge tone="red">
              {blocking.length} blocking
            </Badge>
          )}
          <span className="text-xs font-normal text-muted">
            {done}/{items.length}
          </span>
        </span>
      </CardHeader>

      <CardContent className="space-y-3">
        {subtitle && <p className="text-xs text-muted">{subtitle}</p>}

        <div className="h-1.5 overflow-hidden rounded-full bg-surface-sunken">
          <div
            className={`h-full rounded-full ${percent === 100 ? "bg-success" : blocking.length > 0 ? "bg-danger" : "bg-brand"}`}
            style={{ width: `${percent}%` }}
          />
        </div>

        <div className="space-y-1.5">
          {items.map((item) => (
            <div key={item.key} className="flex items-start gap-2">
              {item.done ? (
                <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
              ) : item.blocking ? (
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" />
              ) : (
                <Circle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-subtle" />
              )}
              <span className="min-w-0 flex-1">
                <span className={`block text-sm ${item.done ? "text-muted line-through decoration-line" : "text-text"}`}>
                  {item.href && !item.done ? (
                    <Link href={item.href} className="hover:underline">
                      {item.label}
                    </Link>
                  ) : (
                    item.label
                  )}
                </span>
                {/* The hint is only worth the space while the thing is still undone. */}
                {!item.done && <span className="block text-xs text-subtle">{item.hint}</span>}
              </span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
