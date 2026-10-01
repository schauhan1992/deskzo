import Link from "next/link";
import { cn } from "@/lib/utils";

const CARD = "rounded-xl border border-line bg-surface shadow-sm";

/** A grey block where something will be. Reduced motion is clamped globally, so the pulse needs no guard. */
function Bar({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn("animate-pulse rounded-md bg-surface-sunken", className)} />;
}

/** One section of the form: its title, then a label and a field per slot, two to a row from small screens up. */
function Section({ title, fields }: { title: string; fields: number }) {
  return (
    <div className={CARD}>
      <div className="border-b border-line px-5 py-3.5">
        <h2 className="text-sm font-medium text-text">{title}</h2>
      </div>
      <div className="grid grid-cols-1 gap-4 px-5 py-4 sm:grid-cols-2">
        {Array.from({ length: fields }, (_, i) => (
          <div key={i} className="space-y-2">
            <Bar className="h-3 w-24" />
            <Bar className="h-9 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * While /orders/new loads: the page's own header, then the shape the form arrives in — the section
 * cards, the folded ones as single lines, and the order summary beside them (below them on a phone).
 *
 * The page waits on the customer and product lists before it can send anything, so without this a
 * click on "Punch order" showed nothing at all until the whole form was ready. The titles are the
 * form's own, so nothing moves when it replaces this.
 */
export default function NewOrderLoading() {
  return (
    <div>
      <div className="mb-5">
        <Link href="/orders" className="text-sm text-muted hover:text-text">
          ← Orders
        </Link>
        <h1 className="mt-1 text-xl font-semibold text-text">Punch order</h1>
        <Bar className="mt-1.5 h-4 w-[28rem] max-w-full" />
      </div>
      <div role="status" aria-live="polite">
        <span className="sr-only">Loading the order form…</span>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="space-y-6">
            <Section title="Customer" fields={4} />
            <Section title="Product and price" fields={4} />
            <Section title="Terms and hand-off" fields={2} />
            <div className={cn(CARD, "divide-y divide-line")}>
              {Array.from({ length: 3 }, (_, i) => (
                <div key={i} className="px-5 py-3.5">
                  <Bar className="h-4 w-40" />
                </div>
              ))}
            </div>
          </div>
          <div className="lg:sticky lg:top-20 lg:self-start">
            <div className={CARD}>
              <div className="border-b border-line px-5 py-3.5">
                <h2 className="text-sm font-medium text-text">Order summary</h2>
              </div>
              <div className="space-y-3 px-5 py-4">
                {Array.from({ length: 5 }, (_, i) => (
                  <div key={i} className="flex items-center justify-between gap-4">
                    <Bar className="h-3 w-24" />
                    <Bar className="h-3 w-16" />
                  </div>
                ))}
                <Bar className="mt-2 h-10 w-full" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
