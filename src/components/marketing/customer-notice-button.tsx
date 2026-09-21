"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, Mail } from "lucide-react";
import type { noticeRecipients } from "@/actions/order-notice";
import { noticeRecipients as loadRecipients, sendCustomerNotice } from "@/actions/order-notice";
import type { NoticeKind } from "@/lib/marketing/customer-notices";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Label, Select, Textarea } from "@/components/ui/input";
import { formatCurrency, formatDate } from "@/lib/utils";

type Loaded = NonNullable<Awaited<ReturnType<typeof noticeRecipients>>>;

/** Used only for the split second before the dialog's own copy arrives. */
const label = (kind: NoticeKind) =>
  kind === "FULFILMENT" ? "Tell them the order is done" : "Send a renewal reminder";

/**
 * Writing to a customer about one order, by hand — a renewal coming up, or one just fulfilled.
 *
 * Everybody at the company is listed with whether they can actually be written to, worked out
 * *before* anything is sent — so a bounced address or a spam complaint is visible at the moment of
 * choosing rather than reported afterwards. Nobody is pre-ticked except the primary contact:
 * "send to all" should be a decision, not a default.
 */
export function CustomerNoticeButton({
  companyProductId,
  companyName,
  kind = "RENEWAL",
}: {
  companyProductId: string;
  companyName: string;
  kind?: NoticeKind;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [loaded, setLoaded] = useState<{ id: string; data: Loaded } | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [templateId, setTemplateId] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ sent: number; failed: number; skipped: { name: string; reason: string }[] } | null>(
    null,
  );

  const data = loaded?.id === companyProductId ? loaded.data : null;

  useEffect(() => {
    if (!open || data) return;
    let cancelled = false;
    loadRecipients(companyProductId, kind).then((rows) => {
      if (cancelled || !rows) return;
      setLoaded({ id: companyProductId, data: rows });
      // The primary contact, if they can actually receive it. Everyone else is a deliberate tick.
      const primary = rows.contacts.find((c) => c.isPrimary && c.canReceive) ?? rows.contacts.find((c) => c.canReceive);
      setChosen(new Set(primary ? [primary.id] : []));
    });
    return () => {
      cancelled = true;
    };
  }, [open, companyProductId, kind, data]);

  const sendable = data?.contacts.filter((c) => c.canReceive) ?? [];
  const blocked = data?.contacts.filter((c) => !c.canReceive) ?? [];
  const allChosen = sendable.length > 0 && sendable.every((c) => chosen.has(c.id));

  const close = () => {
    setOpen(false);
    setResult(null);
    setError(null);
    setNote("");
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={`${data?.title ?? label(kind)} — ${companyName}`}
        aria-label={`${data?.title ?? label(kind)} — ${companyName}`}
        className="rounded p-1 text-subtle hover:bg-surface-sunken hover:text-brand"
      >
        <Mail className="h-4 w-4" />
      </button>

      <Dialog open={open} onClose={close} title={data?.title ?? label(kind)}>
        {result ? (
          <div className="space-y-4">
            <p className="flex items-center gap-2 text-sm text-success">
              <Check className="h-4 w-4" />
              Sent to {result.sent} {result.sent === 1 ? "person" : "people"}.
            </p>
            {result.failed > 0 && (
              <p className="text-sm text-danger">
                {result.failed} couldn&apos;t be delivered — check the provider is set up in Settings.
              </p>
            )}
            {result.skipped.length > 0 && (
              <Card className="border-warning/40 bg-warning-bg px-3 py-2 text-xs text-warning">
                {result.skipped.map((s) => (
                  <p key={s.name}>
                    <span className="font-medium">{s.name}</span> — {s.reason}
                  </p>
                ))}
              </Card>
            )}
            <Button onClick={close}>Done</Button>
          </div>
        ) : !data ? (
          <p className="py-6 text-sm text-subtle">Looking up who we can write to…</p>
        ) : (
          <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
            <Card className="bg-surface-sunken px-3 py-2.5">
              <p className="text-sm font-medium text-text">{data.subscription.itemName}</p>
              <p className="mt-0.5 text-xs text-muted">
                {data.subscription.quantity} × · expires{" "}
                {data.subscription.endDate ? formatDate(data.subscription.endDate) : "—"}
                {data.subscription.renewalValue > 0 && ` · ${formatCurrency(data.subscription.renewalValue)} to renew`}
                {data.subscription.addonCount > 0 && ` · includes ${data.subscription.addonCount} added batch(es)`}
              </p>
            </Card>

            {/* The distinction that matters on a reseller's order. */}
            {data.viaReseller && (
              <Card className="border-info/40 bg-info-bg px-3 py-2.5 text-xs text-info">
                The seats belong to <span className="font-medium">{data.endCustomer?.name}</span>, but this goes to{" "}
                <span className="font-medium">{data.recipientCompany.name}</span> — they own the relationship and the
                renewal. We don&apos;t write to their customer directly.
              </Card>
            )}

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Who at {data.recipientCompany.name}</Label>
                {sendable.length > 1 && (
                  <button
                    type="button"
                    className="text-xs text-brand hover:underline"
                    onClick={() => setChosen(allChosen ? new Set() : new Set(sendable.map((c) => c.id)))}
                  >
                    {allChosen ? "None" : `All ${sendable.length}`}
                  </button>
                )}
              </div>

              {data.contacts.length === 0 && (
                <p className="text-sm text-warning">
                  Nobody is on file at {data.recipientCompany.name}. Add a contact first.
                </p>
              )}

              {sendable.map((contact) => (
                <label
                  key={contact.id}
                  className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-line px-3 py-2 hover:bg-surface-sunken"
                >
                  <input
                    type="checkbox"
                    checked={chosen.has(contact.id)}
                    onChange={() =>
                      setChosen((current) => {
                        const next = new Set(current);
                        if (next.has(contact.id)) next.delete(contact.id);
                        else next.add(contact.id);
                        return next;
                      })
                    }
                    className="mt-0.5 h-4 w-4 accent-brand"
                  />
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm text-text">{contact.name}</span>
                      {contact.isPrimary && <Badge tone="blue">Primary</Badge>}
                      <span className="text-[11px] text-subtle">
                        {contact.designation.toLowerCase().replaceAll("_", " ")}
                      </span>
                    </span>
                    <span className="block text-xs text-muted">{contact.email}</span>
                  </span>
                </label>
              ))}

              {blocked.length > 0 && (
                <div className="space-y-1 rounded-lg bg-surface-sunken px-3 py-2">
                  <p className="text-xs font-medium text-text">Can&apos;t be written to</p>
                  {blocked.map((contact) => (
                    <p key={contact.id} className="flex items-start gap-1.5 text-[11px] text-subtle">
                      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-warning" />
                      <span>
                        <span className="text-muted">{contact.name}</span> — {contact.blockedBecause}
                      </span>
                    </p>
                  ))}
                </div>
              )}
            </div>

            {data.templates.length > 0 && (
              <div className="space-y-1.5">
                <Label htmlFor="rtpl">Wording</Label>
                <Select id="rtpl" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                  <option value="">Standard renewal reminder</option>
                  {data.templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="rnote">Add a line of your own</Label>
              <Textarea
                id="rnote"
                rows={2}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Optional — goes above the standard wording."
              />
            </div>

            {error && <p className="text-sm text-danger">{error}</p>}

            <p className="text-xs text-subtle">{data.footnote}</p>

            <div className="flex gap-2">
              <Button
                disabled={pending || chosen.size === 0}
                onClick={() => {
                  setError(null);
                  startTransition(async () => {
                    const outcome = await sendCustomerNotice({
                      companyProductId,
                      kind,
                      contactIds: [...chosen],
                      templateId: templateId || undefined,
                      note,
                    });
                    if (!outcome.ok) {
                      setError(outcome.error);
                      return;
                    }
                    setResult(outcome.data);
                    router.refresh();
                  });
                }}
              >
                {pending
                  ? "Sending…"
                  : `Send to ${chosen.size} ${chosen.size === 1 ? "person" : "people"}`}
              </Button>
              <Button variant="secondary" onClick={close}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}
