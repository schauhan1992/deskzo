import Link from "next/link";
import { ArrowRight, CheckCircle2, Circle } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { progressOf, type GettingStartedStep } from "@/lib/help/getting-started";
import { cn } from "@/lib/utils";

const GROUPS: { key: GettingStartedStep["group"]; label: string; hint: string }[] = [
  { key: "company", label: "Your company", hint: "Once, for everybody" },
  { key: "you", label: "You", hint: "Just for your account" },
];

/**
 * The Getting Started tab — see src/lib/help/getting-started.ts. Every tick comes from the data, so
 * there is nothing here to mark done; doing the thing is what ticks it.
 */
export function GettingStarted({ steps }: { steps: GettingStartedStep[] }) {
  const { done, total, percent } = progressOf(steps);

  return (
    <div className="max-w-3xl space-y-4">
      <div>
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-base font-semibold text-text">{done === total ? "You're all set" : "Get set up"}</h2>
          <span className="text-sm text-muted">
            {done} of {total} done
          </span>
        </div>
        <div
          className="mt-2 h-2 overflow-hidden rounded-full bg-surface-sunken"
          role="progressbar"
          aria-label="Setup progress"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={done}
        >
          <div className="h-full rounded-full bg-brand transition-[width]" style={{ width: `${percent}%` }} />
        </div>
      </div>

      {GROUPS.map((group) => {
        const inGroup = steps.filter((s) => s.group === group.key);
        if (inGroup.length === 0) return null;
        return (
          <Card key={group.key}>
            <CardHeader className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-text">{group.label}</h3>
              <span className="text-xs text-subtle">{group.hint}</span>
            </CardHeader>
            <CardContent className="p-0">
              <ul className="divide-y divide-line">
                {inGroup.map((step) => (
                  <li key={step.key} className="flex items-start gap-3 px-5 py-3.5">
                    {step.done ? (
                      <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" aria-hidden="true" />
                    ) : (
                      <Circle className="mt-0.5 h-5 w-5 shrink-0 text-line-strong" aria-hidden="true" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className={cn("text-sm font-medium", step.done ? "text-muted line-through decoration-line-strong" : "text-text")}>
                        {step.title}
                        <span className="sr-only">{step.done ? " — done" : " — to do"}</span>
                      </p>
                      <p className="mt-0.5 text-xs text-muted">{step.description}</p>
                    </div>
                    {!step.done && (
                      <Link
                        href={step.href}
                        className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-base px-2 py-1 text-xs font-medium text-brand hover:bg-brand-subtle"
                      >
                        {step.action}
                        <ArrowRight className="h-3 w-3" />
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        );
      })}

      <p className="text-xs text-subtle">
        Tip: press <kbd className="rounded border border-line bg-surface-sunken px-1 font-mono text-[11px]">/</kbd> on any page to search.
      </p>
    </div>
  );
}
