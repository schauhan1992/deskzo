import { cn } from "@/lib/utils";

/** A grey placeholder block. Reduced motion is clamped globally, so the pulse needs no guard here. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn("animate-pulse rounded-md bg-surface-sunken", className)} />;
}

const CARD = "rounded-xl border border-line bg-surface shadow-sm";

/**
 * The console's loading page: header bars, a row of KPI tiles and a table — the shape most pages
 * arrive in, so the layout does not jump when the real one replaces it.
 */
export function PageSkeleton({ kpis = 4, rows = 8 }: { kpis?: number; rows?: number }) {
  return (
    <div role="status" aria-live="polite" className="space-y-6">
      <span className="sr-only">Loading…</span>
      <div className="space-y-2">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-6 w-56" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      {kpis > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: kpis }, (_, i) => (
            <div key={i} className={cn(CARD, "space-y-3 p-4")}>
              <div className="flex items-center gap-2.5">
                <Skeleton className="h-8 w-8 rounded-lg" />
                <Skeleton className="h-3 w-24" />
              </div>
              <Skeleton className="h-7 w-20" />
              <Skeleton className="h-3 w-32" />
            </div>
          ))}
        </div>
      )}
      {rows > 0 && (
        <div className={CARD}>
          <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-8 w-24" />
          </div>
          <div className="divide-y divide-line">
            {Array.from({ length: rows }, (_, i) => (
              <div key={i} className="flex items-center gap-4 px-5 py-3">
                <Skeleton className="h-4 w-1/4" />
                <Skeleton className="h-4 w-16 rounded-full" />
                <Skeleton className="h-4 w-1/5" />
                <Skeleton className="ml-auto h-4 w-12" />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
