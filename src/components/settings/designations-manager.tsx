"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Merge, Trash2 } from "lucide-react";
import { deleteDesignation, mergeDesignations, renameDesignation, setDesignationKind, type DesignationRow } from "@/actions/designation";
import { contactDesignationLabels, contactDesignationValues } from "@/lib/validation/company";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input, Select } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";

/**
 * Settings › Lists › Contact designations (owner, 8 Oct 2026). Names are added as contacts are saved;
 * here they are renamed, given the type lead scoring and assignment rules go by, and merged when two
 * mean the same ("IT Mgr" and "IT Manager") — the duplicate's contacts move to the one that stays.
 */
export function DesignationsManager({ designations }: { designations: DesignationRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [names, setNames] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [merging, setMerging] = useState<DesignationRow | null>(null);
  const [into, setInto] = useState("");

  function run(work: () => Promise<{ ok: true; data?: unknown } | { ok: false; error: string }>, done?: string) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await work();
      if (!result.ok) return setError(result.error);
      if (done) setNotice(done);
      setMerging(null);
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        Added as contacts are saved with them. Each has a type — what lead scoring, assignment rules and campaign filters go
        by — and two that mean the same can be merged.
      </p>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-success">
          {notice}
        </p>
      )}
      <div className="divide-y divide-line">
        {designations.map((d) => {
          const name = names[d.id] ?? d.name;
          const dirty = name.trim() !== d.name && name.trim().length > 0;
          return (
            <div key={d.id} className="flex flex-wrap items-center gap-2 py-2">
              <Input
                aria-label={`Rename ${d.name}`}
                value={name}
                onChange={(e) => setNames((n) => ({ ...n, [d.id]: e.target.value }))}
                className="min-w-40 flex-1"
              />
              {dirty && (
                <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => run(() => renameDesignation(d.id, name), "Renamed.")}>
                  Save
                </Button>
              )}
              <Select
                aria-label={`Type of ${d.name}`}
                value={d.kind}
                disabled={pending}
                onChange={(e) => run(() => setDesignationKind(d.id, e.target.value), `${d.name} is now of type ${contactDesignationLabels[e.target.value as keyof typeof contactDesignationLabels]}.`)}
                className="w-44"
              >
                {contactDesignationValues.map((k) => (
                  <option key={k} value={k}>
                    {contactDesignationLabels[k]}
                  </option>
                ))}
              </Select>
              <span className="w-24 text-right text-xs text-subtle">
                {d.contacts} contact{d.contacts === 1 ? "" : "s"}
              </span>
              <IconButton
                icon={Merge}
                label={`Merge ${d.name} into another designation`}
                disabled={pending || designations.length < 2}
                onClick={() => {
                  setInto("");
                  setError(null);
                  setMerging(d);
                }}
              />
              <IconButton
                icon={Trash2}
                tone="danger"
                label={d.contacts > 0 ? `${d.name} is in use — merge it instead` : `Delete ${d.name}`}
                disabled={pending || d.contacts > 0}
                onClick={() => run(() => deleteDesignation(d.id), `${d.name} deleted.`)}
              />
            </div>
          );
        })}
        {designations.length === 0 && <p className="py-2 text-sm text-subtle">None yet — they&apos;re added as contacts are saved.</p>}
      </div>

      <Dialog open={!!merging} onClose={() => setMerging(null)} title={`Merge “${merging?.name}”`}>
        <p className="text-sm text-muted">
          Its {merging?.contacts} contact{merging?.contacts === 1 ? "" : "s"} take the designation you pick — and its type — and
          &ldquo;{merging?.name}&rdquo; is removed from the list.
        </p>
        <Select aria-label="Merge into" value={into} onChange={(e) => setInto(e.target.value)} className="mt-3 w-full">
          <option value="">Merge into…</option>
          {designations
            .filter((d) => d.id !== merging?.id)
            .map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
        </Select>
        {error && merging && (
          <p role="alert" className="mt-2 text-xs text-danger">
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => setMerging(null)} disabled={pending}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!into || pending}
            onClick={() => merging && run(() => mergeDesignations(merging.id, into), `${merging.name} merged.`)}
          >
            {pending ? "Merging…" : "Merge"}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
