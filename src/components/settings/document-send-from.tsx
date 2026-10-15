"use client";

import { useState, useTransition } from "react";
import { saveDocumentSendMode } from "@/actions/document-mail";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DOCUMENT_SEND_MODES, documentSendModeLabels, type DocumentSendMode } from "@/lib/documents/mail-route-labels";

/**
 * Settings → Document emails: where an emailed document goes out from (owner, 15 Oct 2026). Saved as it
 * is picked. Whatever is picked, a company with no mail set up at all still sends — through Deskzo.
 */
export function DocumentSendFrom({ initial, companyRoute }: { initial: DocumentSendMode; companyRoute: { label: string; fromEmail: string | null } | null }) {
  const [mode, setMode] = useState(initial);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [pending, start] = useTransition();

  const pick = (next: DocumentSendMode) => {
    const before = mode;
    setMode(next);
    setNotice(null);
    start(async () => {
      const res = await saveDocumentSendMode(next);
      if (res.ok) setNotice({ tone: "ok", text: "Saved." });
      else {
        setMode(before);
        setNotice({ tone: "error", text: res.error });
      }
    });
  };

  return (
    <Card>
      <CardHeader>
        <h2 className="text-sm font-medium text-text">Send documents from</h2>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div role="radiogroup" aria-label="Send documents from" className="space-y-2">
          {DOCUMENT_SEND_MODES.map((m) => (
            <label key={m} className="flex cursor-pointer items-start gap-2.5">
              <input type="radio" name="doc-send-from" className="mt-1" checked={mode === m} disabled={pending} onChange={() => pick(m)} />
              <span>
                <span className="block text-text">{documentSendModeLabels[m].label}</span>
                <span className="block text-xs text-muted">{documentSendModeLabels[m].hint}</span>
              </span>
            </label>
          ))}
        </div>
        <p className="rounded-base bg-surface-sunken px-3 py-2 text-xs text-muted">
          {companyRoute ? (
            <>
              The company&apos;s mail server is set up: <span className="text-text">{companyRoute.fromEmail ?? companyRoute.label}</span> ({companyRoute.label}), from
              Settings › Messaging.
            </>
          ) : (
            <>The company&apos;s mail server isn&apos;t set up yet — add one (SMTP, Microsoft 365, Amazon SES…) for transactional mail under Settings › Messaging.</>
          )}{" "}
          When nothing chosen here is set up, documents still go out — through Deskzo&apos;s mail service, in the sender&apos;s and your company&apos;s name, with replies to the
          sender.
        </p>
        {notice && <p className={notice.tone === "ok" ? "text-xs text-success" : "text-xs text-danger"}>{notice.text}</p>}
      </CardContent>
    </Card>
  );
}
