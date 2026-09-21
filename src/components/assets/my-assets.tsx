"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, Laptop } from "lucide-react";
import type { assetsHeldBy } from "@/actions/it-asset";
import { acknowledgeMovement } from "@/actions/it-asset";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/utils";
import { assetKindLabels, coverState, statusLabels, statusTone } from "@/lib/assets/lifecycle";

type Asset = Awaited<ReturnType<typeof assetsHeldBy>>[number];

/**
 * What one person is holding, and the confirmation that they have it.
 *
 * The acknowledgement is the point of this page existing separately from the register. A handover
 * nobody confirmed is the state that becomes "I never got that laptop" a year later, and only the
 * person it went to can settle it.
 */
export function MyAssets({ assets }: { assets: Asset[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const unconfirmed = assets.filter((a) => a.movements[0] && !a.movements[0].acknowledgedAt);

  return (
    <div className="space-y-4">
      {error && <Card className="border-danger/40 bg-danger-bg px-4 py-3 text-sm text-danger">{error}</Card>}

      {unconfirmed.length > 0 && (
        <Card className="border-warning/40 bg-warning-bg px-4 py-3 text-sm text-warning">
          {unconfirmed.length === 1 ? "One item is" : `${unconfirmed.length} items are`} on your name without you
          having confirmed. If you have it, say so — if you don&apos;t, tell IT now rather than when you leave.
        </Card>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {assets.map((a) => {
          const cover = coverState(a);
          const handover = a.movements[0];
          return (
            <Card key={a.id} className="px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link href={`/assets/${a.id}`} className="flex items-center gap-1.5 font-medium text-text hover:underline">
                    <Laptop className="h-3.5 w-3.5 shrink-0 text-subtle" />
                    {a.name}
                  </Link>
                  <p className="mt-0.5 font-mono text-xs text-subtle">{a.assetTag}</p>
                  <p className="mt-0.5 text-xs text-muted">
                    {assetKindLabels[a.kind]}
                    {a.make && ` · ${a.make}`}
                    {a.serialNumber && ` · S/N ${a.serialNumber}`}
                  </p>
                </div>
                <Badge tone={statusTone[a.status]}>{statusLabels[a.status]}</Badge>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                <Badge tone={cover.tone}>{cover.label}</Badge>
                {handover && <span className="text-subtle">Given to you {formatDate(handover.occurredAt)}</span>}
              </div>

              {handover && !handover.acknowledgedAt && (
                <Button
                  size="sm"
                  className="mt-3"
                  disabled={pending}
                  onClick={() => {
                    setError(null);
                    startTransition(async () => {
                      const result = await acknowledgeMovement(handover.id);
                      if (!result.ok) {
                        setError(result.error);
                        return;
                      }
                      router.refresh();
                    });
                  }}
                >
                  <Check className="mr-1.5 h-3.5 w-3.5" />
                  Yes, I have it
                </Button>
              )}
              {handover?.acknowledgedAt && (
                <p className="mt-3 flex items-center gap-1.5 text-xs text-success">
                  <Check className="h-3.5 w-3.5" />
                  Confirmed {formatDate(handover.acknowledgedAt)}
                </p>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
