"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Download, Merge, Plus } from "lucide-react";
import type { VisitorCompanySource } from "@prisma/client";
import { importVendorCompanies, mergeVisitorCompanies, saveVisitorCompany } from "@/actions/visitor";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ActionNoticeRegion, type NoticeTone } from "@/components/ui/action-notice";
import { Input, Label, Select } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/bulk-select";
import { formatDate } from "@/lib/utils";

type Row = {
  id: string;
  name: string;
  source: VisitorCompanySource;
  visitCount: number;
  lastSeenAt: string | Date | null;
  active: boolean;
  _count: { entries: number };
};

const sourceLabels: Record<VisitorCompanySource, string> = {
  VISITOR: "Typed by a visitor",
  VENDOR: "From our vendors",
  MANUAL: "Added here",
};

const sourceTone: Record<VisitorCompanySource, "default" | "blue" | "green"> = {
  VISITOR: "default",
  VENDOR: "blue",
  MANUAL: "green",
};

/**
 * The list the reception tablet searches.
 *
 * Kept away from the CRM's own company table on purpose — see the model comment. This screen is
 * where somebody tidies it: bring the vendors across, fold duplicates together, and switch off
 * anything that should stop being offered.
 */
export function VisitorCompanies({ rows }: { rows: Row[] }) {
  const router = useRouter();
  const [adding, setAdding] = useState("");
  const [merging, setMerging] = useState<Row | null>(null);
  const [message, setMessage] = useState<{ tone: NoticeTone; message: string } | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3">
          <p className="max-w-lg text-xs text-muted">
            This is what a visitor sees when they start typing their company. It holds vendors you bring across
            and names visitors have typed — never your customers, because the tablet needs no login.
          </p>
          <Button
            variant="secondary"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await importVendorCompanies();
                setMessage(
                  result.ok
                    ? {
                        tone: "success",
                        // Green for a success and red for a refusal, which were the same colour.
                        message: `${result.data.added} vendors added, ${result.data.adopted} existing entries linked up.`,
                      }
                    : { tone: "error", message: result.error },
                );
                router.refresh();
              })
            }
          >
            <Download className="mr-1.5 h-3.5 w-3.5" />
            Bring our vendors across
          </Button>
        </CardContent>
      </Card>

      <ActionNoticeRegion notice={message} />

      <Card>
        <CardHeader className="text-sm font-medium text-text">Add one by hand</CardHeader>
        <CardContent className="flex flex-wrap items-end gap-2">
          <div className="min-w-48 flex-1 space-y-1.5">
            <Label htmlFor="new-co">Company name</Label>
            <Input id="new-co" value={adding} onChange={(e) => setAdding(e.target.value)} placeholder="Northwind Traders" />
          </div>
          <Button
            disabled={pending || adding.trim().length < 2}
            onClick={() =>
              startTransition(async () => {
                const result = await saveVisitorCompany({ name: adding });
                if (!result.ok) {
                  setMessage({ tone: "error", message: result.error });
                  return;
                }
                setAdding("");
                setMessage(null);
                router.refresh();
              })
            }
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </CardContent>
      </Card>

      {rows.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted">
            Nothing here yet. Bring your vendors across, or let it fill up as visitors arrive.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="space-y-2">
            {rows.map((r) => (
              <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-2 last:border-0 last:pb-0">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`text-sm ${r.active ? "text-text" : "text-muted line-through"}`}>{r.name}</span>
                    <Badge tone={sourceTone[r.source]}>{sourceLabels[r.source]}</Badge>
                  </div>
                  <p className="text-xs text-subtle">
                    {r._count.entries} visit{r._count.entries === 1 ? "" : "s"}
                    {r.lastSeenAt && ` · last ${formatDate(new Date(r.lastSeenAt))}`}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-1.5 text-xs text-muted">
                    <Checkbox
                      checked={r.active}
                      onChange={async () => {
                        await saveVisitorCompany({ id: r.id, name: r.name, active: !r.active });
                        router.refresh();
                      }}
                    />
                    Offered
                  </label>
                  <Button size="sm" variant="ghost" onClick={() => setMerging(r)}>
                    <Merge className="mr-1.5 h-3.5 w-3.5" />
                    Merge
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {merging && (
        <Card>
          <CardHeader className="text-sm font-medium text-text">Fold &ldquo;{merging.name}&rdquo; into another</CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted">
              Its visits move across and it stops being offered. What each visitor actually typed stays on their
              own record.
            </p>
            <MergePicker
              from={merging}
              options={rows.filter((r) => r.id !== merging.id)}
              onDone={() => {
                setMerging(null);
                router.refresh();
              }}
              onCancel={() => setMerging(null)}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function MergePicker({
  from,
  options,
  onDone,
  onCancel,
}: {
  from: Row;
  options: Row[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const [intoId, setIntoId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="min-w-48 flex-1 space-y-1.5">
        <Label htmlFor="merge-into">Keep</Label>
        <Select id="merge-into" value={intoId} onChange={(e) => setIntoId(e.target.value)}>
          <option value="">Choose…</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </Select>
      </div>
      <Button
        disabled={pending || !intoId}
        onClick={() =>
          startTransition(async () => {
            const result = await mergeVisitorCompanies(from.id, intoId);
            if (!result.ok) {
              setError(result.error);
              return;
            }
            onDone();
          })
        }
      >
        {pending ? "Merging…" : "Merge"}
      </Button>
      <Button variant="secondary" onClick={onCancel}>
        Cancel
      </Button>
      {error && <p className="w-full text-sm text-danger">{error}</p>}
    </div>
  );
}
