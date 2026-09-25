"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { dismissDuplicate, type DuplicateRow } from "@/actions/company-merge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ActionNotice } from "@/components/ui/action-notice";

/**
 * Likely duplicates, a pair to a row. The first company in each is the one suggested to keep — the
 * one with more history under it — and the merge screen can swap them.
 */
export function DuplicatesList({ rows }: { rows: DuplicateRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function dismiss(row: DuplicateRow) {
    const [a, b] = row.companies;
    const key = `${a!.id}|${b!.id}`;
    setBusy(key);
    setError(null);
    startTransition(async () => {
      const result = await dismissDuplicate(a!.id, b!.id);
      setBusy(null);
      if (!result.ok) setError(result.error);
      else router.refresh();
    });
  }

  if (rows.length === 0) {
    return (
      <Card className="px-4 py-6 text-center text-sm text-muted">
        No likely duplicates among the companies you can see.
      </Card>
    );
  }

  return (
    <div className="space-y-2">
      {error && <ActionNotice tone="error">{error}</ActionNotice>}
      {rows.map((row) => {
        const [keep, drop] = row.companies;
        const key = `${keep!.id}|${drop!.id}`;
        return (
          <Card key={key} className="space-y-2 px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${
                  row.strength === "strong" ? "bg-danger/10 text-danger" : "bg-surface-sunken text-muted"
                }`}
              >
                {row.strength === "strong" ? "Very likely" : "Possibly"}
              </span>
              <span className="text-xs text-muted">{row.reasons.join(" · ")}</span>
            </div>
            <div className="grid gap-2 md:grid-cols-2">
              {row.companies.map((c) => (
                <div key={c.id} className="min-w-0 rounded-base border border-line px-3 py-2">
                  <Link href={`/companies/${c.ref}`} className="block truncate text-sm font-medium text-text hover:underline">
                    {c.name}
                  </Link>
                  <p className="text-xs text-muted">
                    <span className="font-mono">{c.ref}</span> · {c.kind}
                    {c.place ? ` · ${c.place}` : ""}
                    {c.manager ? ` · ${c.manager}` : ""} · {c.records} record{c.records === 1 ? "" : "s"}
                  </p>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Link
                href={`/companies/merge?keep=${keep!.ref}&drop=${drop!.ref}`}
                className="inline-flex h-8 items-center rounded-base bg-brand px-3 text-[13px] text-brand-contrast shadow-sm hover:brightness-110"
              >
                Review merge
              </Link>
              <Button size="sm" variant="ghost" disabled={pending && busy === key} onClick={() => dismiss(row)}>
                {pending && busy === key ? "Saving…" : "Not duplicates"}
              </Button>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
