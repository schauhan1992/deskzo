"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Check, X } from "lucide-react";
import { applyVerification, dismissVerification, type pendingVerifications } from "@/actions/verification";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/utils";

type Row = Awaited<ReturnType<typeof pendingVerifications>>["rows"][number];

/**
 * Corrections a caller reported, waiting for somebody to accept or reject them.
 *
 * Both values are shown side by side because the decision is a comparison — a plausible-looking
 * correction to a number that was already right is exactly the case this queue exists to catch.
 */
export function VerificationRows({ rows }: { rows: Row[] }) {
  if (rows.length === 0) {
    return (
      <Card className="px-4 py-12 text-center text-sm text-subtle">
        Nothing waiting. Corrections reported by callers land here for review.
      </Card>
    );
  }

  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <VerificationRow key={row.id} row={row} />
      ))}
    </div>
  );
}

function VerificationRow({ row }: { row: Row }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run(action: "apply" | "dismiss") {
    setError(null);
    startTransition(async () => {
      const result = action === "apply" ? await applyVerification(row.id) : await dismissVerification(row.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  const isCorrection = row.status === "CORRECTED" && row.correctedValue;

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Link href={`/companies/${row.company.id}`} className="font-medium text-text hover:underline">
              {row.company.name}
            </Link>
            {row.contact && <span className="text-sm text-muted">{row.contact.name}</span>}
            <Badge tone={row.status === "CORRECTED" ? "amber" : "red"}>
              {row.field === "EMAIL" ? "Email" : "Phone"} {row.status === "CORRECTED" ? "corrected" : "wrong"}
            </Badge>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2 font-mono text-sm">
            <span className="rounded-base bg-danger-bg px-2 py-0.5 text-danger line-through">{row.originalValue}</span>
            {isCorrection && (
              <>
                <ArrowRight className="h-3.5 w-3.5 text-subtle" />
                <span className="rounded-base bg-success-bg px-2 py-0.5 text-success">{row.correctedValue}</span>
              </>
            )}
          </div>

          {row.note && <p className="mt-1.5 text-sm text-muted">{row.note}</p>}
          <p className="mt-1 text-xs text-subtle">
            {row.verifiedBy.name} · {formatDateTime(row.verifiedAt)}
          </p>
          {error && <p className="mt-1 text-sm text-danger">{error}</p>}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {isCorrection && (
            <Button size="sm" disabled={pending} onClick={() => run("apply")}>
              <Check className="mr-1.5 h-3.5 w-3.5" />
              Apply
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => run("dismiss")}>
            <X className="mr-1.5 h-3.5 w-3.5" />
            {isCorrection ? "Reject" : "Acknowledge"}
          </Button>
        </div>
      </div>
    </Card>
  );
}
