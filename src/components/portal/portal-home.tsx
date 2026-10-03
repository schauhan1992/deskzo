"use client";

import { useState, useTransition } from "react";
import { CalendarClock, CheckCircle2, FileText, LifeBuoy, MessageSquare, Package, RefreshCw, UserPlus } from "lucide-react";
import {
  raisePortalRequest,
  type PortalInvoice,
  type PortalSubscription,
  type PortalTicket,
  type PortalView,
} from "@/actions/portal-public";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { useClock } from "@/components/time/clock-provider";
import { formatCurrency } from "@/lib/utils";
import { formatCalendarDay } from "@/lib/time/zone";

/**
 * What the customer actually sees.
 *
 * Written for somebody who does not work here and did not ask to learn our vocabulary. No order
 * ids, no internal statuses that need translating, no empty section headings for things they were
 * never given. A section that is switched off is simply not on the page — the server has already
 * declined to send its data, and this draws only what arrived.
 */

function expiryTone(daysLeft: number | null): { tone: "green" | "amber" | "red" | "default"; text: string } {
  if (daysLeft === null) return { tone: "default", text: "No end date" };
  if (daysLeft < 0) return { tone: "red", text: `Expired ${Math.abs(daysLeft)} days ago` };
  if (daysLeft <= 30) return { tone: "red", text: `${daysLeft} days left` };
  if (daysLeft <= 90) return { tone: "amber", text: `${daysLeft} days left` };
  return { tone: "green", text: `${daysLeft} days left` };
}

export function PortalHome({
  token,
  view,
  subscriptions,
  invoices,
  tickets,
}: {
  token: string;
  view: PortalView;
  subscriptions: PortalSubscription[];
  invoices: PortalInvoice[];
  tickets: PortalTicket[];
}) {
  const clock = useClock();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState<{ kind: "renewal" | "seats"; id: string; name: string } | null>(null);
  const [seats, setSeats] = useState("1");
  const [question, setQuestion] = useState("");
  const [notice, setNotice] = useState<{ text: string; bad?: boolean } | null>(null);

  const can = (a: string) => view.actions.includes(a as "renewal");
  const shows = (s: string) => view.sections.includes(s as "subscriptions");

  const send = (kind: "renewal" | "seats" | "question", companyProductId?: string, quantity?: number) => {
    setBusy(true);
    setNotice(null);
    startTransition(async () => {
      const result = await raisePortalRequest(token, {
        kind,
        companyProductId,
        quantity,
        message: kind === "question" ? question : undefined,
      });
      setBusy(false);
      if (!result.ok) {
        setNotice({ text: result.error, bad: true });
        return;
      }
      setAsking(null);
      setQuestion("");
      setSeats("1");
      setNotice({
        text:
          kind === "question"
            ? "Thanks — we've got your question and someone will come back to you."
            : "Thanks — we've passed that to your account manager, who'll be in touch.",
      });
    });
  };

  return (
    <div className="mx-auto max-w-4xl space-y-5 px-4 py-8 sm:px-6">
      <header>
        {view.ourName && <p className="text-sm text-muted">{view.ourName}</p>}
        <h1 className="mt-0.5 text-2xl font-semibold text-text">
          Hello {view.personName}
        </h1>
        <p className="mt-1 text-sm text-muted">
          Your account with us — {view.companyName}.
        </p>
        {view.welcome && (
          <p className="mt-3 rounded-base border border-line bg-surface-sunken px-3 py-2 text-sm text-text">
            {view.welcome}
          </p>
        )}
      </header>

      {notice && (
        <div
          className={
            notice.bad
              ? "rounded-base border border-danger/40 bg-danger-bg px-3 py-2.5 text-sm text-danger"
              : "flex items-start gap-2 rounded-base border border-success/40 bg-success-bg px-3 py-2.5 text-sm text-success"
          }
        >
          {!notice.bad && <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />}
          {notice.text}
        </div>
      )}

      {shows("subscriptions") && (
        <Card>
          <CardHeader className="flex items-center gap-2 text-sm font-medium text-text">
            <Package className="h-4 w-4 text-muted" />
            Your subscriptions and orders
          </CardHeader>
          <CardContent className="p-0">
            {subscriptions.length === 0 ? (
              <p className="px-5 py-8 text-center text-sm text-muted">Nothing here yet.</p>
            ) : (
              <ul className="divide-y divide-line">
                {subscriptions.map((s) => {
                  const expiry = expiryTone(s.daysLeft);
                  return (
                    <li key={s.id} className="px-5 py-3">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-text">{s.name}</p>
                          <p className="mt-0.5 text-xs text-muted">
                            {/* "1 licence" is wrong for a meeting-room bar. A term is what makes
                                something a licence; without one it is just a quantity. */}
                            {s.endDate
                              ? `${s.quantity} ${s.quantity === 1 ? "licence" : "licences"} · until ${formatCalendarDay(s.endDate)}`
                              : `Quantity ${s.quantity}`}
                          </p>
                        </div>
                        <Badge tone={expiry.tone}>
                          <CalendarClock className="h-3 w-3" />
                          {expiry.text}
                        </Badge>
                      </div>

                      {/*
                        Only for something with a term. A one-off purchase has nothing to renew and
                        no seats to add, and offering both raises requests nobody can act on.
                      */}
                      {s.endDate !== null && (can("renewal") || can("seats")) && (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {can("renewal") && (
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={busy}
                              onClick={() => send("renewal", s.id)}
                            >
                              <RefreshCw className="h-3.5 w-3.5" />
                              Renew this
                            </Button>
                          )}
                          {can("seats") && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy}
                              onClick={() => {
                                setAsking({ kind: "seats", id: s.id, name: s.name });
                                setNotice(null);
                              }}
                            >
                              <UserPlus className="h-3.5 w-3.5" />
                              Add licences
                            </Button>
                          )}
                        </div>
                      )}

                      {asking?.kind === "seats" && asking.id === s.id && (
                        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-base bg-surface-sunken p-2">
                          <label className="text-xs text-muted" htmlFor={`seats-${s.id}`}>
                            How many more?
                          </label>
                          <Input
                            id={`seats-${s.id}`}
                            className="h-8 w-20 text-[13px]"
                            inputMode="numeric"
                            value={seats}
                            onChange={(e) => setSeats(e.target.value)}
                          />
                          <Button size="sm" disabled={busy} onClick={() => send("seats", s.id, Number(seats))}>
                            Ask for these
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setAsking(null)}>
                            Cancel
                          </Button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      {shows("invoices") && (
        <Card>
          <CardHeader className="flex items-center gap-2 text-sm font-medium text-text">
            <FileText className="h-4 w-4 text-muted" />
            Your invoices
          </CardHeader>
          <CardContent className="p-0">
            {invoices.length === 0 ? (
              <p className="px-5 py-8 text-center text-sm text-muted">Nothing here yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-xs text-muted">
                      <th className="px-5 py-2 font-medium">Number</th>
                      <th className="px-5 py-2 font-medium">Date</th>
                      <th className="px-5 py-2 font-medium">Due</th>
                      <th className="px-5 py-2 font-medium">Amount</th>
                      <th className="px-5 py-2 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoices.map((i) => (
                      <tr key={i.id} className="border-b border-line last:border-0">
                        <td className="whitespace-nowrap px-5 py-2.5 font-medium text-text">{i.number}</td>
                        <td className="whitespace-nowrap px-5 py-2.5 text-muted">{formatCalendarDay(i.date)}</td>
                        <td className="whitespace-nowrap px-5 py-2.5 text-muted">
                          {i.dueDate ? formatCalendarDay(i.dueDate) : "—"}
                        </td>
                        <td className="whitespace-nowrap px-5 py-2.5 text-text">{formatCurrency(i.total)}</td>
                        <td className="px-5 py-2.5">
                          <Badge tone={i.status === "PAID" ? "green" : i.status === "CREDIT_NOTE" ? "blue" : "amber"}>
                            {/* Their word for it, not ours. "ISSUED" means nothing to a customer. */}
                            {i.status === "PAID"
                              ? "Paid"
                              : i.status === "PARTIALLY_PAID"
                                ? "Part paid"
                                : i.status === "CREDIT_NOTE"
                                  ? "Credit note"
                                  : "Outstanding"}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {shows("tickets") && (
        <Card>
          <CardHeader className="flex items-center gap-2 text-sm font-medium text-text">
            <LifeBuoy className="h-4 w-4 text-muted" />
            Your support tickets
          </CardHeader>
          <CardContent className="p-0">
            {tickets.length === 0 ? (
              <p className="px-5 py-8 text-center text-sm text-muted">Nothing open.</p>
            ) : (
              <ul className="divide-y divide-line">
                {tickets.map((t) => (
                  <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5">
                    <div className="min-w-0">
                      <p className="text-sm text-text">
                        <span className="font-mono text-xs text-muted">{t.reference}</span> {t.title}
                      </p>
                      <p className="text-xs text-muted">Raised {clock.date(t.createdAt)}</p>
                    </div>
                    <Badge tone={t.status === "CLOSED" || t.status === "RESOLVED" ? "green" : "amber"}>
                      {t.status.toLowerCase().replace(/_/g, " ")}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      {can("question") && (
        <Card>
          <CardHeader className="flex items-center gap-2 text-sm font-medium text-text">
            <MessageSquare className="h-4 w-4 text-muted" />
            Ask us something
          </CardHeader>
          <CardContent className="space-y-2">
            <Textarea
              rows={3}
              aria-label="Ask us something"
              placeholder="When does our Adobe subscription expire? Could you resend invoice 1043?"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
            />
            <div className="flex justify-end">
              <Button disabled={busy || !question.trim()} onClick={() => send("question")}>
                Send
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/*
        Said plainly, because the link is a bearer credential sitting in somebody's inbox and the
        person holding it should know that.
      */}
      <p className="pb-4 text-center text-xs text-subtle">
        This page is yours — anyone with the link can see it, so please don&rsquo;t forward it. Tell us if you
        need it turned off.
      </p>
    </div>
  );
}
