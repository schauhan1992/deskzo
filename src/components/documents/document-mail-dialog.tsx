"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Loader2, Mail, Paperclip, Plug } from "lucide-react";
import { prepareDocumentEmail, sendDocumentEmail } from "@/actions/document-mail";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";
import { attachmentName, mergeTemplate, recipientNames } from "@/lib/documents/email-template";
import { formatIstDateTime } from "@/lib/india-time";
import { MAIL_NAMES, SIGN_IN_NAMES, mailConnectPath } from "@/lib/workplace/providers";
import { cn } from "@/lib/utils";

type Prepared = Extract<Awaited<ReturnType<typeof prepareDocumentEmail>>, { ok: true }>;

/**
 * The Mail button on a document, and the dialog it opens: who it goes to, what it says, and what is
 * attached — sent from the person's own mailbox: Outlook, Gmail or Zoho Mail. See src/actions/document-mail.ts.
 *
 * The message is merged as recipients are ticked ("Dear Rahul and Priya"), until somebody edits it
 * by hand; from then on it is theirs, and ticking changes nothing they wrote.
 */
export function DocumentMailButton({ documentId }: { documentId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, startLoading] = useTransition();
  const [sending, startSending] = useTransition();
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [subject, setSubject] = useState<string | null>(null);
  const [body, setBody] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  function openDialog() {
    setOpen(true);
    setNotice(null);
    setLoadError(null);
    setPrepared(null);
    setSubject(null);
    setBody(null);
    startLoading(async () => {
      try {
        const r = await prepareDocumentEmail(documentId);
        if (!r.ok) {
          setLoadError(r.error);
          return;
        }
        setPrepared(r);
        setSelected(r.preselected);
      } catch {
        setLoadError("This couldn't be loaded. Try again.");
      }
    });
  }

  const names = prepared ? recipientNames(prepared.contacts.filter((c) => selected.includes(c.id)).map((c) => c.name)) : "";
  const values = prepared ? { ...prepared.values, "recipient.names": names } : {};
  // Merged live until edited. A template that can't be merged (a due date the document doesn't
  // have, say) is shown as written, with the reason, so it can be fixed here.
  const mergedSubject = prepared ? mergeTemplate(prepared.template.subject, values) : null;
  const mergedBody = prepared ? mergeTemplate(prepared.template.body, values) : null;
  const shownSubject = subject ?? (mergedSubject?.ok ? mergedSubject.text : (prepared?.template.subject ?? ""));
  const shownBody = body ?? (mergedBody?.ok ? mergedBody.text : (prepared?.template.body ?? ""));
  const mergeProblem = (subject === null && mergedSubject && !mergedSubject.ok ? mergedSubject.error : null) ?? (body === null && mergedBody && !mergedBody.ok ? mergedBody.error : null);

  const connected = prepared?.mailbox.state === "connected";

  function send() {
    if (!prepared) return;
    setNotice(null);
    startSending(async () => {
      const r = await sendDocumentEmail({ documentId, contactIds: selected, subject: shownSubject, body: shownBody });
      if (!r.ok) {
        setNotice({ tone: "error", text: r.error });
        return;
      }
      setNotice({ tone: "success", text: `Sent to ${r.data.sentTo.join(", ")} from ${r.data.from}. It's in your ${r.data.mailName} Sent folder.` });
      router.refresh();
    });
  }

  const sent = notice?.tone === "success";

  return (
    <>
      <Button variant="secondary" onClick={openDialog}>
        <Mail className="mr-1.5 h-3.5 w-3.5" />
        Mail
      </Button>

      <Dialog open={open} onClose={() => !sending && setOpen(false)} title={prepared ? `Email ${prepared.document.label.toLowerCase()} ${prepared.document.number ?? ""}` : "Email document"} wide>
        {loading && (
          <p className="flex items-center gap-2 py-6 text-sm text-muted">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </p>
        )}
        {loadError && <ActionNotice tone="error">{loadError}</ActionNotice>}

        {prepared && (
          <div className="space-y-4">
            {/* From */}
            <div className="rounded-lg border border-line bg-surface-sunken px-3 py-2.5 text-sm">
              {prepared.mailbox.state === "connected" ? (
                <p className="text-text">
                  <span className="text-muted">From </span>
                  <span className="font-medium">{prepared.mailbox.mailbox}</span>
                  <span className="text-muted"> — your {MAIL_NAMES[prepared.mailbox.provider]}. A copy lands in your Sent folder.</span>
                </p>
              ) : prepared.mailbox.state === "app-missing" ? (
                <p className="flex items-start gap-2 text-muted">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                  Your company hasn&apos;t set up Microsoft 365, Google Workspace or Zoho for mail yet. An admin does it under Settings → Security.
                </p>
              ) : prepared.viewingAs ? (
                <p className="text-muted">You&apos;re viewing as somebody else — mail can only be sent from your own account.</p>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-muted">
                    {prepared.mailbox.state === "broken"
                      ? `${SIGN_IN_NAMES[prepared.mailbox.provider]} stopped accepting your ${MAIL_NAMES[prepared.mailbox.provider]} connection (${prepared.mailbox.mailbox}). Connect it again to send.`
                      : "Connect your mailbox once, and documents go out from your own address."}
                  </p>
                  {/* A full navigation: the provider's sign-in page is not something to open in a fetch. */}
                  <div className="flex flex-wrap gap-2">
                    {(prepared.mailbox.state === "broken" ? [prepared.mailbox.provider] : prepared.mailbox.providers).map((provider) => (
                      <a
                        key={provider}
                        href={mailConnectPath(provider, `/documents/${documentId}`)}
                        className="inline-flex items-center gap-1.5 rounded-base bg-brand px-3 py-1.5 text-sm font-medium text-brand-contrast hover:brightness-110"
                      >
                        <Plug className="h-3.5 w-3.5" />
                        {prepared.mailbox.state === "broken" ? "Reconnect" : "Connect"} {MAIL_NAMES[provider]}
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* To */}
            <fieldset>
              <legend className="mb-1.5 text-sm font-medium text-text">To — {prepared.document.customer}</legend>
              {prepared.contacts.length === 0 ? (
                <p className="text-sm text-muted">This customer has no contacts yet. Add one on the customer&apos;s page first.</p>
              ) : (
                <ul className="max-h-52 divide-y divide-line overflow-y-auto rounded-lg border border-line">
                  {prepared.contacts.map((c) => {
                    const checked = selected.includes(c.id);
                    return (
                      <li key={c.id}>
                        <label className={cn("flex items-start gap-3 px-3 py-2", c.canReceive ? "cursor-pointer hover:bg-surface-sunken" : "opacity-60")}>
                          <input
                            type="checkbox"
                            className="mt-1"
                            checked={checked}
                            disabled={!c.canReceive || sending || sent}
                            onChange={(e) => setSelected((prev) => (e.target.checked ? [...prev, c.id] : prev.filter((id) => id !== c.id)))}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="flex flex-wrap items-center gap-1.5 text-sm text-text">
                              {c.name}
                              {c.receivesDocuments && <span className="rounded-full bg-brand-subtle px-1.5 text-[11px] text-brand">Receives invoices</span>}
                              {c.isPrimary && <span className="rounded-full bg-surface-sunken px-1.5 text-[11px] text-muted">Primary</span>}
                            </span>
                            <span className="block truncate text-xs text-muted">{c.email ?? "No email address"}</span>
                            {!c.canReceive && c.blockedBecause && <span className="block text-xs text-danger">{c.blockedBecause}</span>}
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </fieldset>

            <div className="space-y-1">
              <Label htmlFor="doc-mail-subject">Subject</Label>
              <Input id="doc-mail-subject" value={shownSubject} onChange={(e) => setSubject(e.target.value)} maxLength={200} disabled={sending || sent} />
            </div>
            <div className="space-y-1">
              <div className="flex items-baseline justify-between gap-2">
                <Label htmlFor="doc-mail-body">Message</Label>
                {(subject !== null || body !== null) && !sent && (
                  <button
                    type="button"
                    className="text-xs text-muted hover:text-text hover:underline"
                    onClick={() => {
                      setSubject(null);
                      setBody(null);
                    }}
                  >
                    Back to the template
                  </button>
                )}
              </div>
              <Textarea id="doc-mail-body" rows={10} value={shownBody} onChange={(e) => setBody(e.target.value)} maxLength={10000} disabled={sending || sent} />
              {mergeProblem && <p className="text-xs text-warning">{mergeProblem}</p>}
            </div>

            <p className="flex items-center gap-1.5 text-xs text-muted">
              <Paperclip className="h-3.5 w-3.5" />
              {attachmentName(prepared.document.label, prepared.document.number)} — the same PDF as Print, made when you press Send.
            </p>
            {prepared.document.lastEmailedAt && (
              <p className="text-xs text-subtle">Last emailed {formatIstDateTime(prepared.document.lastEmailedAt)}.</p>
            )}

            {notice && <ActionNotice tone={notice.tone}>{notice.text}</ActionNotice>}

            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setOpen(false)} disabled={sending}>
                {sent ? "Close" : "Cancel"}
              </Button>
              {!sent && (
                <Button onClick={send} disabled={sending || !connected || selected.length === 0 || prepared.viewingAs}>
                  {sending ? (
                    <>
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Making the PDF and sending…
                    </>
                  ) : (
                    <>
                      <Mail className="mr-1.5 h-3.5 w-3.5" /> Send to {selected.length} {selected.length === 1 ? "person" : "people"}
                    </>
                  )}
                </Button>
              )}
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}
