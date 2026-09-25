"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Phone } from "lucide-react";
import { saveHelpDesk, type HelpDeskView } from "@/actions/help";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";

/** The helpline in the corner of the dashboard — with a preview of exactly how it will read. */
export function HelpDeskForm({ initial }: { initial: HelpDeskView | null }) {
  const router = useRouter();
  const [label, setLabel] = useState(initial?.label ?? "");
  const [phone, setPhone] = useState(initial?.phone ?? "");
  const [hours, setHours] = useState(initial?.hours ?? "");
  const [languages, setLanguages] = useState(initial?.languages ?? "");
  const [email, setEmail] = useState(initial?.email ?? "");
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function save() {
    setNotice(null);
    startTransition(async () => {
      const r = await saveHelpDesk({ label, phone, hours, languages, email });
      if (!r.ok) {
        setNotice({ tone: "error", text: r.error });
        return;
      }
      setNotice({ tone: "success", text: phone.trim() || email.trim() ? "Saved — it's on the dashboard now." : "Saved. Nothing is shown until there's a number or an email." });
      router.refresh();
    });
  }

  const shown = phone.trim() || email.trim();

  return (
    <Card>
      <CardHeader>
        <h2 className="text-sm font-semibold text-text">Helpline</h2>
        <p className="mt-0.5 text-xs text-muted">Shown at the top right of everybody&apos;s dashboard and in the Help panel. Leave the number and email empty to hide it.</p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="help-label">Label</Label>
            <Input id="help-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Wroffy Support" maxLength={60} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="help-phone">Phone number</Label>
            <Input id="help-phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="1800 123 4567" maxLength={30} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="help-hours">Hours</Label>
            <Input id="help-hours" value={hours} onChange={(e) => setHours(e.target.value)} placeholder="Mon – Fri • 9:30 AM – 6:30 PM" maxLength={80} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="help-languages">Languages</Label>
            <Input id="help-languages" value={languages} onChange={(e) => setLanguages(e.target.value)} placeholder="English, हिन्दी" maxLength={120} />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="help-email">Support email</Label>
            <Input id="help-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="support@yourcompany.com" maxLength={120} />
          </div>
        </div>

        <div>
          <p className="mb-1.5 text-xs font-medium text-subtle">Preview</p>
          <div className="rounded-lg border border-dashed border-line-strong bg-surface-sunken px-4 py-3 text-right text-xs text-muted">
            {shown ? (
              <>
                {phone.trim() && (
                  <p className="text-sm text-text">
                    {label.trim() ? `${label.trim()}: ` : "Helpline: "}
                    <span className="font-semibold">
                      <Phone className="mr-1 inline h-3.5 w-3.5 align-[-2px] text-brand" aria-hidden="true" />
                      {phone.trim()}
                    </span>
                  </p>
                )}
                {hours.trim() && <p className="mt-0.5">{hours.trim()}</p>}
                {languages.trim() && <p className="mt-0.5">{languages.trim()}</p>}
                {email.trim() && <p className="mt-0.5">{email.trim()}</p>}
              </>
            ) : (
              <p className="text-left">Nothing shown yet.</p>
            )}
          </div>
        </div>

        {notice && <ActionNotice tone={notice.tone}>{notice.text}</ActionNotice>}
        <Button onClick={save} disabled={pending}>
          {pending ? "Saving…" : "Save helpline"}
        </Button>
      </CardContent>
    </Card>
  );
}
