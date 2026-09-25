"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FileUp, ShieldCheck } from "lucide-react";
import type { MarketingTopic } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/bulk-select";
import { Input, Label, Textarea } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";
import { TOPICS } from "@/lib/marketing/topics";

type Summary = {
  listId: string;
  rows: number;
  invalid: number;
  duplicates: number;
  tooMany: boolean;
  matchedContacts: number;
  createdContacts: number;
  createdCompanies: number;
  consentRecorded: number;
  alreadyUnsubscribed: number;
  checked: { valid: number; risky: number; invalid: number; unknown: number };
};

/**
 * Upload a CSV of people for a mass mail. Asks the one question the law asks — how did they agree to
 * hear from us — and won't go without an answer. Each row becomes a contact, so an unsubscribe sticks.
 */
export function ListUploader({ defaultTopic, onUploaded }: { defaultTopic?: MarketingTopic; onUploaded?: (listId: string, name: string) => void }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [topics, setTopics] = useState<MarketingTopic[]>([defaultTopic ?? "OFFERS"]);
  const [consentNote, setConsentNote] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);

  const submit = () =>
    startTransition(async () => {
      if (!file) return;
      setError(null);
      const data = new FormData();
      data.set("file", file);
      data.set("name", name);
      data.set("consentNote", consentNote);
      data.set("confirmed", confirmed ? "yes" : "no");
      for (const t of topics) data.append("topics", t);
      const response = await fetch("/api/marketing/lists/upload", { method: "POST", body: data });
      const result = (await response.json().catch(() => ({ ok: false, error: "The upload failed." }))) as { ok: true; data: Summary } | { ok: false; error: string };
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSummary(result.data);
      onUploaded?.(result.data.listId, name);
      router.refresh();
    });

  if (summary) {
    const c = summary.checked;
    return (
      <div className="space-y-2 text-sm">
        <ActionNotice tone="success">
          “{name}” uploaded — {summary.rows} people: {summary.matchedContacts} already in the CRM, {summary.createdContacts} added as new contacts
          {summary.createdCompanies ? ` (under ${summary.createdCompanies} new companies)` : ""}.
        </ActionNotice>
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted">
          {summary.invalid > 0 && <li>{summary.invalid} rows skipped — not a valid email address.</li>}
          {summary.duplicates > 0 && <li>{summary.duplicates} repeated addresses counted once.</li>}
          {summary.tooMany && <li>Only the first 5,000 were taken — split bigger lists.</li>}
          <li>Consent recorded for {summary.consentRecorded} topic subscriptions, with your note as the evidence.</li>
          {summary.alreadyUnsubscribed > 0 && <li>{summary.alreadyUnsubscribed} had already unsubscribed — they stay unsubscribed and won&apos;t be mailed.</li>}
          {c.valid + c.risky + c.invalid + c.unknown > 0 && (
            <li>
              Addresses checked just now: {c.valid} good, {c.risky} shared or free-mail (held back from marketing), {c.invalid} not working
              {c.unknown ? `, ${c.unknown} couldn't be checked` : ""}.
            </li>
          )}
        </ul>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="list-name">List name</Label>
          <Input id="list-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Pune roundtable, Sep 2026" />
        </div>
        <div className="space-y-1.5">
          <Label>CSV file</Label>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              e.target.value = "";
              setFile(f);
              if (f && !name) setName(f.name.replace(/\.(csv|txt)$/i, ""));
            }}
          />
          <Button type="button" variant="secondary" size="sm" onClick={() => fileRef.current?.click()} className="w-full justify-start">
            <FileUp className="h-3.5 w-3.5" /> {file ? file.name : "Choose a .csv"}
          </Button>
          <p className="text-[11px] text-subtle">Columns: Email (required), Name, Company, Phone, Designation — the first row names them.</p>
        </div>
      </div>

      <fieldset>
        <legend className="mb-1 text-sm font-medium text-text">What did they agree to hear about?</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {TOPICS.map((t) => (
            <label key={t.key} className="flex cursor-pointer items-center gap-1.5 text-xs text-text">
              <Checkbox checked={topics.includes(t.key)} onChange={(e) => setTopics((v) => (e.target.checked ? [...v, t.key] : v.filter((k) => k !== t.key)))} />
              {t.label}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="space-y-1.5">
        <Label htmlFor="consent-note">How did they agree?</Label>
        <Textarea id="consent-note" rows={2} value={consentNote} onChange={(e) => setConsentNote(e.target.value)} placeholder="Signed up for updates at our Pune roundtable on 12 Sep 2026" />
      </div>
      <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-line bg-surface-sunken px-3 py-2 text-xs text-text">
        <Checkbox checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-0.5" />
        <span>
          <ShieldCheck className="mr-1 inline h-3.5 w-3.5 text-success" aria-hidden />
          These people agreed to hear from us about the topics ticked. This list wasn&apos;t bought or scraped. My note above is recorded as the
          evidence against every one of them.
        </span>
      </label>

      {error && <ActionNotice tone="error">{error}</ActionNotice>}
      <Button size="sm" disabled={pending || !file || !name.trim() || !confirmed || consentNote.trim().length < 10 || topics.length === 0} onClick={submit}>
        {pending ? "Uploading and checking addresses…" : "Upload list"}
      </Button>
    </div>
  );
}
