"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, MessageSquareQuote } from "lucide-react";
import type { feedbackTargets } from "@/actions/feedback";
import { createFeedbackRequest, feedbackTargets as loadTargets } from "@/actions/feedback";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { OutboundLink, whatsappHref } from "@/components/ui/outbound-link";
import { useClock } from "@/components/time/clock-provider";

type Targets = Awaited<ReturnType<typeof feedbackTargets>>;

const EMPTY: Targets = { contacts: [], people: [], tickets: [], visits: [], orders: [] };

/**
 * Asking one customer how it went.
 *
 * The thing being asked about is picked from work that is actually finished — a closed ticket, a
 * completed visit, a fulfilled order — rather than typed, because a rating against "support" tells
 * you nothing you can act on and a rating against a named job tells you everything.
 *
 * There is no mail provider wired up yet, so what comes back is the link itself, ready to paste
 * into WhatsApp or an email. That is how most of these actually travel anyway.
 */
export function AskFeedbackDialog({
  companyId,
  companyName,
  origin,
  label,
  preset,
}: {
  companyId: string;
  companyName: string;
  /** Absolute, because the link has to work when it is pasted somewhere else. */
  origin: string;
  label?: string;
  preset?: { ticketId?: string; visitId?: string; companyProductId?: string; aboutUserId?: string };
}) {
  const router = useRouter();
  const clock = useClock();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Held with the company it was loaded for, so a stale list can never be shown against the wrong
  // customer — and so this derives during render rather than being cleared from inside an effect.
  const [loaded, setLoaded] = useState<{ companyId: string; targets: Targets } | null>(null);
  const targets = loaded?.companyId === companyId ? loaded.targets : EMPTY;

  const [contactId, setContactId] = useState("");
  const [aboutUserId, setAboutUserId] = useState(preset?.aboutUserId ?? "");
  const [about, setAbout] = useState(
    preset?.ticketId
      ? `ticket:${preset.ticketId}`
      : preset?.visitId
        ? `visit:${preset.visitId}`
        : preset?.companyProductId
          ? `order:${preset.companyProductId}`
          : "",
  );
  const [serviceLabel, setServiceLabel] = useState("");
  const [message, setMessage] = useState("");
  const [created, setCreated] = useState<{ token: string; reference: string; expiresAt: string | Date } | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    loadTargets(companyId).then((rows) => {
      if (!cancelled) setLoaded({ companyId, targets: rows });
    });
    return () => {
      cancelled = true;
    };
  }, [open, companyId]);

  const contact = targets.contacts.find((c) => c.id === contactId);
  const url = created ? `${origin}/review/${created.token}` : null;

  // Picking a job also suggests who did it — the person the customer actually dealt with is almost
  // always the one assigned to it, and making somebody choose again invites the wrong name.
  function chooseAbout(value: string) {
    setAbout(value);
    const [kind, id] = value.split(":");
    if (aboutUserId) return;
    if (kind === "ticket") setAboutUserId(targets.tickets.find((t) => t.id === id)?.assignedTo?.id ?? "");
    if (kind === "visit") setAboutUserId(targets.visits.find((v) => v.id === id)?.user?.id ?? "");
    if (kind === "order") setAboutUserId(targets.orders.find((o) => o.id === id)?.addedBy?.id ?? "");
  }

  function reset() {
    setOpen(false);
    setCreated(null);
    setCopied(false);
    setError(null);
  }

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <MessageSquareQuote className="mr-1.5 h-3.5 w-3.5" />
        {label ?? "Ask for feedback"}
      </Button>

      <Dialog open={open} onClose={reset} title={created ? "Send them this link" : `Ask ${companyName} how it went`}>
        {created && url ? (
          <div className="space-y-4">
            <p className="text-sm text-muted">
              {created.reference} · open until {clock.date(created.expiresAt)}. It works once, then it closes.
            </p>

            <div className="flex items-center gap-2">
              <Input
                aria-label="Feedback link"
                readOnly
                value={url}
                className="font-mono text-xs"
                onFocus={(e) => e.currentTarget.select()}
              />
              <Button
                variant="secondary"
                onClick={() => {
                  navigator.clipboard.writeText(url).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  });
                }}
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              </Button>
            </div>

            <div className="flex flex-wrap gap-2">
              {contact?.phone && (
                <OutboundLink
                  href={whatsappHref(
                    contact.phone,
                    `Hello ${contact.name.split(" ")[0]}, could you tell us how we did? It takes a minute: ${url}`,
                  )}
                  className="rounded-lg border border-line px-3 py-1.5 text-xs text-text hover:bg-surface-sunken"
                >
                  Send on WhatsApp
                </OutboundLink>
              )}
              {contact?.email && (
                <a
                  href={`mailto:${contact.email}?subject=${encodeURIComponent("How did we do?")}&body=${encodeURIComponent(
                    `Hello ${contact.name.split(" ")[0]},\n\nCould you tell us how we did? It takes about a minute:\n${url}\n\nThank you.`,
                  )}`}
                  className="rounded-lg border border-line px-3 py-1.5 text-xs text-text hover:bg-surface-sunken"
                >
                  Open in email
                </a>
              )}
            </div>

            <p className="text-xs text-subtle">
              Anybody holding this link can answer it, so send it to {contact?.name ?? "them"} and nobody else.
            </p>

            <div className="flex gap-2">
              <Button onClick={reset}>Done</Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="contact">Who are we asking?</Label>
              <Select id="contact" value={contactId} onChange={(e) => setContactId(e.target.value)}>
                <option value="">Choose a contact…</option>
                {targets.contacts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.isPrimary ? " (primary)" : ""}
                    {c.email ? ` — ${c.email}` : c.phone ? ` — ${c.phone}` : ""}
                  </option>
                ))}
              </Select>
              {contactId && !contact?.email && !contact?.phone && (
                <p className="text-xs text-warning">
                  No email or phone on this contact — you can still copy the link and send it yourself.
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="about">What about?</Label>
              <Select id="about" value={about} onChange={(e) => chooseAbout(e.target.value)}>
                <option value="">How we&apos;re doing generally</option>
                {targets.tickets.length > 0 && (
                  <optgroup label="Support tickets">
                    {targets.tickets.map((t) => (
                      <option key={t.id} value={`ticket:${t.id}`}>
                        #{t.ticketSeq} — {t.title}
                      </option>
                    ))}
                  </optgroup>
                )}
                {targets.visits.length > 0 && (
                  <optgroup label="Site visits">
                    {targets.visits.map((v) => (
                      <option key={v.id} value={`visit:${v.id}`}>
                        {clock.date(v.scheduledFor)} — {v.purpose.toLowerCase().replaceAll("_", " ")}
                      </option>
                    ))}
                  </optgroup>
                )}
                {targets.orders.length > 0 && (
                  <optgroup label="What they bought">
                    {targets.orders.map((o) => (
                      <option key={o.id} value={`order:${o.id}`}>
                        {o.item.name} × {o.quantity}
                      </option>
                    ))}
                  </optgroup>
                )}
              </Select>
              <p className="text-xs text-subtle">
                Only finished work is listed. Asking somebody to rate an open ticket asks them to score something
                nobody has done yet.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="person">Who dealt with them?</Label>
              <Select id="person" value={aboutUserId} onChange={(e) => setAboutUserId(e.target.value)}>
                <option value="">Nobody in particular</option>
                {targets.people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-subtle">
                Named, and the form asks about them by name. They see what was said about them either way.
              </p>
            </div>

            {!about && (
              <div className="space-y-1.5">
                <Label htmlFor="label">Or describe it</Label>
                <Input
                  id="label"
                  value={serviceLabel}
                  onChange={(e) => setServiceLabel(e.target.value)}
                  placeholder="The Microsoft 365 migration"
                />
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="msg">A line from you</Label>
              <Textarea
                id="msg"
                rows={2}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Optional — shown above the form."
              />
            </div>

            {error && <p className="text-sm text-danger">{error}</p>}

            <div className="flex gap-2">
              <Button
                disabled={pending}
                onClick={() => {
                  setError(null);
                  const [kind, id] = about.split(":");
                  startTransition(async () => {
                    const result = await createFeedbackRequest({
                      companyId,
                      contactId: contactId || undefined,
                      aboutUserId: aboutUserId || undefined,
                      ticketId: kind === "ticket" ? id : undefined,
                      visitId: kind === "visit" ? id : undefined,
                      companyProductId: kind === "order" ? id : undefined,
                      serviceLabel: serviceLabel || undefined,
                      message: message || undefined,
                    });
                    if (!result.ok) {
                      setError(result.error);
                      return;
                    }
                    setCreated(result.data);
                    router.refresh();
                  });
                }}
              >
                {pending ? "Making the link…" : "Make the link"}
              </Button>
              <Button variant="secondary" onClick={reset}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}
