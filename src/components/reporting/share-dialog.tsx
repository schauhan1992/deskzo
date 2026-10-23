"use client";

import { useEffect, useMemo, useState } from "react";
import { Building2, Link2, Search, User, X } from "lucide-react";
import { shareReport, shareTargets } from "@/actions/reporting";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export type ShareEntry = { userId: string | null; departmentId: string | null; name: string; canEdit: boolean };

/**
 * Who a report is shared with — the owner's to change. Sharing gives the report, never the data: everyone sees
 * the rows their own role allows (src/actions/reporting.ts shareReport), which the dialog says plainly.
 */
export function ShareDialog({
  reportId,
  reportName,
  shares,
  onClose,
  onShared,
}: {
  reportId: string;
  reportName: string;
  shares: ShareEntry[];
  onClose: () => void;
  onShared: (sharedWith: string, shares: ShareEntry[]) => void;
}) {
  const [list, setList] = useState<ShareEntry[]>(shares);
  const [targets, setTargets] = useState<{ people: { id: string; name: string; department: string | null }[]; departments: { id: string; name: string }[] } | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    shareTargets()
      .then((res) => live && (res.ok ? setTargets(res.data) : setError(res.error)))
      .catch(() => live && setError("Couldn't load people. Try again."));
    return () => {
      live = false;
    };
  }, []);

  const matches = useMemo(() => {
    if (!targets || !search.trim()) return [];
    const q = search.trim().toLowerCase();
    const taken = new Set(list.map((s) => s.userId ?? `d:${s.departmentId}`));
    const depts = targets.departments.filter((d) => !taken.has(`d:${d.id}`) && d.name.toLowerCase().includes(q)).map((d) => ({ kind: "dept" as const, id: d.id, name: `${d.name} team`, hint: "Department" }));
    const people = targets.people.filter((p) => !taken.has(p.id) && p.name.toLowerCase().includes(q)).map((p) => ({ kind: "person" as const, id: p.id, name: p.name, hint: p.department ?? "" }));
    return [...depts, ...people].slice(0, 8);
  }, [targets, search, list]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await shareReport({ id: reportId, shares: list.map((s) => (s.userId ? { userId: s.userId, canEdit: s.canEdit } : { departmentId: s.departmentId!, canEdit: s.canEdit })) });
      if (!res.ok) return setError(res.error);
      onShared(res.data.sharedWith, list);
    } catch {
      setError("Couldn't save the sharing. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title={`Share “${reportName}”`}>
      <div className="space-y-3">
        <label className="relative block">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-subtle" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={targets ? "Add a person or a department…" : "Loading people…"}
            disabled={!targets}
            className="h-9 w-full rounded-lg border border-line bg-surface pl-8 pr-2.5 text-[13px] text-text outline-none focus:border-brand"
          />
        </label>
        {matches.length > 0 && (
          <div className="overflow-hidden rounded-lg border border-line">
            {matches.map((m) => (
              <button
                key={`${m.kind}:${m.id}`}
                type="button"
                onClick={() => {
                  setList([...list, { userId: m.kind === "person" ? m.id : null, departmentId: m.kind === "dept" ? m.id : null, name: m.name, canEdit: false }]);
                  setSearch("");
                }}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] hover:bg-surface-sunken"
              >
                {m.kind === "dept" ? <Building2 className="h-4 w-4 text-subtle" /> : <User className="h-4 w-4 text-subtle" />}
                <span className="flex-1 text-text">{m.name}</span>
                <span className="text-[12px] text-subtle">{m.hint}</span>
              </button>
            ))}
          </div>
        )}

        <div className="space-y-1">
          <p className="text-[12px] font-medium uppercase tracking-wide text-subtle">Shared with</p>
          {list.length === 0 && <p className="py-2 text-[13px] text-muted">Only you can open this report.</p>}
          {list.map((s, i) => (
            <div key={s.userId ?? `d:${s.departmentId}`} className="flex items-center gap-2.5 rounded-lg px-1 py-1.5">
              {s.departmentId ? <Building2 className="h-4 w-4 text-subtle" /> : <User className="h-4 w-4 text-subtle" />}
              <span className="min-w-0 flex-1 truncate text-[13px] text-text">{s.name}</span>
              <select
                aria-label={`What ${s.name} can do`}
                value={s.canEdit ? "edit" : "view"}
                onChange={(e) => setList(list.map((x, j) => (j === i ? { ...x, canEdit: e.target.value === "edit" } : x)))}
                className="h-8 rounded-md border border-line bg-surface px-2 text-[12.5px] text-text"
              >
                <option value="view">Can view</option>
                <option value="edit">Can edit</option>
              </select>
              <button type="button" aria-label={`Stop sharing with ${s.name}`} onClick={() => setList(list.filter((_, j) => j !== i))} className="grid h-7 w-7 place-items-center rounded-md text-subtle hover:bg-surface-sunken hover:text-danger">
                <X className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>

        <p className="rounded-lg bg-surface-sunken px-3 py-2 text-[12.5px] text-muted">
          Sharing gives the report, not the data. Each person sees only the records their own role allows — somebody who can&apos;t open the source
          sees that, and can ask you for access.
        </p>

        {error && (
          <p role="alert" className="text-[13px] text-danger">
            {error}
          </p>
        )}
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(`${window.location.origin}/reports/${reportId}`).then(() => setCopied(true));
            }}
            className={cn("inline-flex items-center gap-1.5 text-[13px] font-medium", copied ? "text-success" : "text-brand hover:underline")}
          >
            <Link2 className="h-4 w-4" />
            {copied ? "Link copied" : "Copy link"}
          </button>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button type="button" size="sm" onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save sharing"}
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
