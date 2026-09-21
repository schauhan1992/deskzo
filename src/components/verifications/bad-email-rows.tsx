"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MailCheck } from "lucide-react";
import type { badEmailContacts } from "@/actions/email-verification";
import { verifyContactEmails } from "@/actions/email-verification";
import { EmailCheckBadge } from "@/components/contacts/email-address";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { emailStatusLabels } from "@/lib/email-verification";
import { formatDateTime } from "@/lib/utils";

type Row = Awaited<ReturnType<typeof badEmailContacts>>["rows"][number];

/**
 * Addresses the last check would not vouch for.
 *
 * This is a worklist rather than a report: the point is that someone goes and finds the right
 * address, which usually means ringing the number next to it. So the phone number is on the row.
 */
export function BadEmailRows({ rows }: { rows: Row[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<string | null>(null);

  if (rows.length === 0) {
    return (
      <Card className="px-4 py-12 text-center text-sm text-subtle">
        Nothing flagged. Every address that has been checked came back usable.
      </Card>
    );
  }

  function recheckAll() {
    setNotice(null);
    startTransition(async () => {
      const result = await verifyContactEmails(rows.map((r) => r.id));
      setNotice(result.ok ? `Re-checked ${result.data.checked}.` : result.error);
      if (result.ok) router.refresh();
    });
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" disabled={pending} onClick={recheckAll}>
          <MailCheck className="mr-1.5 h-3.5 w-3.5" />
          {pending ? "Checking…" : "Re-check this page"}
        </Button>
        {notice && <span className="text-xs text-muted">{notice}</span>}
      </div>

      {rows.map((row) => (
        <Card key={row.id} className="flex flex-wrap items-start justify-between gap-3 p-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Link href={`/companies/${row.company.id}?tab=contacts`} className="font-medium text-text hover:underline">
                {row.name}
              </Link>
              <span className="text-sm text-muted">{row.company.name}</span>
              <Badge tone={row.emailStatus === "INVALID" ? "red" : "amber"}>
                {emailStatusLabels[row.emailStatus]}
              </Badge>
            </div>

            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm">
              <span className="font-mono text-xs text-muted">{row.email}</span>
              <EmailCheckBadge contact={row} />
              {row.phone && <span className="text-xs text-subtle">· {row.phone}</span>}
            </div>

            {row.emailCheckDetail && <p className="mt-1 text-sm text-muted">{row.emailCheckDetail}</p>}
            {row.emailCheckedAt && (
              <p className="mt-1 text-xs text-subtle">Checked {formatDateTime(row.emailCheckedAt)}</p>
            )}
          </div>
        </Card>
      ))}
    </div>
  );
}
