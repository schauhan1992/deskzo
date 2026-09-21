"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, ShieldBan, Trash2 } from "lucide-react";
import type { listSuppressions } from "@/actions/marketing";
import { addSuppression, removeSuppression } from "@/actions/marketing";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { formatDate } from "@/lib/utils";

type Suppression = Awaited<ReturnType<typeof listSuppressions>>[number];

const REASON_LABEL: Record<string, string> = {
  UNSUBSCRIBED: "They asked us to stop",
  HARD_BOUNCE: "Bounced",
  COMPLAINT: "Marked us as spam",
  MANUAL: "Added by hand",
};
const REASON_TONE: Record<string, "default" | "red" | "amber"> = {
  UNSUBSCRIBED: "amber",
  HARD_BOUNCE: "red",
  COMPLAINT: "red",
  MANUAL: "default",
};
const SCOPE_LABEL: Record<string, string> = {
  EMAIL: "Address",
  CONTACT: "Contact",
  COMPANY: "Company",
  DOMAIN: "Whole domain",
};

/**
 * Who we have been told not to contact.
 *
 * Only facts somebody told us. Everything derivable — a reseller's customer, an unanswered
 * complaint, an unverified address — is worked out fresh at send time and deliberately absent from
 * this list, so fixing the underlying problem restores marketability without anybody having to
 * remember to delete a row here.
 */
export function SuppressionList({ rows, canManage }: { rows: Suppression[]; canManage: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [adding, setAdding] = useState(false);
  const [scope, setScope] = useState("EMAIL");
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      {canManage && (
        <Card className="px-4 py-3">
          {adding ? (
            <div className="space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <Label htmlFor="scope">What</Label>
                  <Select id="scope" value={scope} onChange={(e) => setScope(e.target.value)}>
                    {Object.entries(SCOPE_LABEL).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="value">
                    {scope === "DOMAIN" ? "Domain" : scope === "EMAIL" ? "Address" : "Id"}
                  </Label>
                  <Input
                    id="value"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    placeholder={scope === "DOMAIN" ? "example.co.in" : "someone@example.co.in"}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="note">Why</Label>
                <Input id="note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="They rang and asked." />
              </div>
              {error && <p className="text-sm text-danger">{error}</p>}
              <div className="flex gap-2">
                <Button
                  disabled={pending || !value.trim()}
                  onClick={() => {
                    setError(null);
                    startTransition(async () => {
                      const result = await addSuppression({ scope: scope as "EMAIL", value, note });
                      if (!result.ok) {
                        setError(result.error);
                        return;
                      }
                      setAdding(false);
                      setValue("");
                      setNote("");
                      router.refresh();
                    });
                  }}
                >
                  {pending ? "Adding…" : "Add"}
                </Button>
                <Button variant="secondary" onClick={() => setAdding(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button size="sm" onClick={() => setAdding(true)}>
              <Plus className="mr-1.5 h-3 w-3" />
              Suppress somebody
            </Button>
          )}
        </Card>
      )}

      {rows.length === 0 ? (
        <Card className="px-4 py-12 text-center">
          <ShieldBan className="mx-auto mb-2 h-5 w-5 text-subtle" />
          <p className="text-sm text-subtle">
            Nobody is suppressed. Unsubscribes, bounces and spam complaints land here on their own.
          </p>
        </Card>
      ) : (
        <Card className="overflow-hidden p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2.5">What</th>
                <th className="px-4 py-2.5">Who</th>
                <th className="px-4 py-2.5">Why</th>
                <th className="px-4 py-2.5">Since</th>
                {canManage && <th className="px-4 py-2.5" />}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <SuppressionRow key={row.id} row={row} canManage={canManage} />
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

function SuppressionRow({ row, canManage }: { row: Suppression; canManage: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <tr className="border-b border-line last:border-0">
      <td className="px-4 py-2.5 text-muted">{SCOPE_LABEL[row.scope]}</td>
      <td className="px-4 py-2.5 font-mono text-xs text-text">{row.value}</td>
      <td className="px-4 py-2.5">
        <Badge tone={REASON_TONE[row.reason]}>{REASON_LABEL[row.reason]}</Badge>
        {row.note && <span className="block text-[11px] text-subtle">{row.note}</span>}
        {error && <span className="block text-[11px] text-danger">{error}</span>}
      </td>
      <td className="px-4 py-2.5 text-xs text-muted">
        {formatDate(row.createdAt)}
        {row.createdBy && <span className="block text-[11px] text-subtle">{row.createdBy.name}</span>}
      </td>
      {canManage && (
        <td className="px-4 py-2.5 text-right">
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => {
              setError(null);
              startTransition(async () => {
                const result = await removeSuppression(row.id);
                if (!result.ok) {
                  setError(result.error);
                  return;
                }
                router.refresh();
              });
            }}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </td>
      )}
    </tr>
  );
}
