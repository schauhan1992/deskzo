"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateMyCard } from "@/actions/card";
import { MAX_OWN_FIELDS, type CardField } from "@/lib/cards/fields";
import { Button } from "@/components/ui/button";
import { FieldsEditor, type DraftField } from "@/components/cards/fields-editor";

/**
 * The holder's own say over their card: which of their record's fields to leave off (only those the
 * template leaves open), and their own links and numbers. Name, title, phone and photo are their
 * record's — Profile, or HR — and change there.
 */
export function MyCardEditor({
  hideable,
  hidden,
  allowOwnFields,
  ownFields,
}: {
  hideable: { key: string; label: string }[];
  hidden: string[];
  allowOwnFields: boolean;
  ownFields: CardField[];
}) {
  const router = useRouter();
  const [off, setOff] = useState(new Set(hidden));
  const [fields, setFields] = useState<DraftField[]>(ownFields);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();

  function save() {
    setError(null);
    setSaved(false);
    start(async () => {
      const result = await updateMyCard({ hidden: [...off], ...(allowOwnFields ? { ownFields: fields } : {}) });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSaved(true);
      router.refresh();
    });
  }

  return (
    <section className="space-y-5 rounded-xl border border-line bg-surface p-4">
      {hideable.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-text">From your record</h2>
          <p className="text-xs text-muted">Kept in step with your profile. Untick any you&apos;d rather leave off.</p>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {hideable.map((f) => (
              <label key={f.key} className="flex items-center gap-2 text-sm text-text">
                <input
                  type="checkbox"
                  checked={!off.has(f.key)}
                  onChange={(e) => {
                    const next = new Set(off);
                    if (e.target.checked) next.delete(f.key);
                    else next.add(f.key);
                    setOff(next);
                  }}
                />
                {f.label}
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-2">
        <h2 className="text-sm font-semibold text-text">Your own links and numbers</h2>
        {allowOwnFields ? (
          <>
            <p className="text-xs text-muted">LinkedIn, WhatsApp, a booking link — whatever you&apos;d hand somebody. Nothing personal is on your card unless you add it here.</p>
            <FieldsEditor fields={fields} onChange={setFields} max={MAX_OWN_FIELDS} idPrefix="own-field" />
          </>
        ) : (
          <p className="text-xs text-muted">Your company&apos;s card design doesn&apos;t take fields of your own.</p>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-end gap-3">
        {error && <p className="mr-auto text-sm text-danger">{error}</p>}
        {saved && !error && <p className="mr-auto text-sm text-success">Saved. Your card shows it now.</p>}
        <Button type="button" onClick={save} disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
      </div>
    </section>
  );
}
