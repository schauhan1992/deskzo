import { Card, CardContent } from "@/components/ui/card";

/** A workspace whose database hasn't had Finance → Accounts' migration yet: said calmly, rather than an error. */
export function InventoryNotReady({ title }: { title: string }) {
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-text">{title}</h1>
      <Card>
        <CardContent className="text-sm text-muted">
          This workspace&apos;s database hasn&apos;t been brought up to date for warehouses and stock vouchers yet. Items and their
          stock work as before; these screens open once the update has run.
        </CardContent>
      </Card>
    </div>
  );
}
