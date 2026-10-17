"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { saveLeaveOpenings, type LeaveOpeningSheet } from "@/actions/leave-openings";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";

type Draft = { opening: string; usedBefore: string };
const keyOf = (userId: string, typeId: string) => `${userId}:${typeId}`;
const shown = (v: number | null) => (v === null ? "" : String(v));

/**
 * The opening balances sheet (owner, 17 Oct 2026): a row a person, two figures a paid leave type —
 * carried into the year from the old system, and taken this year before Deskzo. Typed in place, or
 * pasted from the old system's export; nothing is saved until Save, and only what changed is sent.
 */
export function LeaveOpeningsSheet({ sheet }: { sheet: LeaveOpeningSheet }) {
  const router = useRouter();
  const initial = useMemo(() => {
    const map = new Map<string, Draft>();
    for (const p of sheet.people) for (const t of sheet.types) map.set(keyOf(p.id, t.id), { opening: shown(p.cells[t.id]!.typed), usedBefore: p.cells[t.id]!.usedBefore ? String(p.cells[t.id]!.usedBefore) : "" });
    return map;
  }, [sheet]);
  const [drafts, setDrafts] = useState(initial);
  const [note, setNote] = useState("");
  const [paste, setPaste] = useState("");
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [pending, start] = useTransition();

  const changed = [...drafts.entries()].filter(([key, d]) => {
    const was = initial.get(key)!;
    return d.opening.trim() !== was.opening || (d.usedBefore.trim() || "0") !== (was.usedBefore || "0");
  });

  const set = (key: string, field: keyof Draft, value: string) => setDrafts((prev) => new Map(prev).set(key, { ...prev.get(key)!, [field]: value }));

  /** Rows of email, leave code, carried in, taken — tabs or commas, a header line skipped. */
  function fillFromPaste() {
    const byEmail = new Map(sheet.people.map((p) => [p.email.toLowerCase(), p.id]));
    const byCode = new Map(sheet.types.map((t) => [t.code.toLowerCase(), t.id]));
    const next = new Map(drafts);
    const missed: string[] = [];
    let filled = 0;
    for (const line of paste.split(/\r?\n/)) {
      const cols = line.split(/\t|,/).map((c) => c.trim());
      if (cols.length < 3 || !cols[0]) continue;
      const userId = byEmail.get(cols[0].toLowerCase());
      const typeId = byCode.get((cols[1] ?? "").toLowerCase());
      if (!userId || !typeId) {
        if (!/email/i.test(cols[0])) missed.push(cols[0]);
        continue;
      }
      next.set(keyOf(userId, typeId), { opening: cols[2] ?? "", usedBefore: cols[3] ?? "" });
      filled += 1;
    }
    setDrafts(next);
    setMessage(
      missed.length
        ? { tone: "error", text: `Filled ${filled}. Not matched to a person and leave code here: ${[...new Set(missed)].slice(0, 8).join(", ")}${missed.length > 8 ? "…" : ""}` }
        : { tone: "ok", text: `Filled ${filled} — check them, then Save.` },
    );
  }

  function save() {
    const rows = changed.map(([key, d]) => {
      const [userId, typeId] = key.split(":") as [string, string];
      return { userId, typeId, opening: d.opening.trim() === "" ? null : Number(d.opening), usedBefore: d.usedBefore.trim() === "" ? 0 : Number(d.usedBefore) };
    });
    if (rows.some((r) => (r.opening !== null && Number.isNaN(r.opening)) || Number.isNaN(r.usedBefore))) {
      setMessage({ tone: "error", text: "Only numbers — whole or half days." });
      return;
    }
    start(async () => {
      setMessage(null);
      const result = await saveLeaveOpenings({ year: sheet.year, rows, note: note.trim() || undefined });
      if (!result.ok) {
        setMessage({ tone: "error", text: result.error });
        return;
      }
      setMessage({ tone: "ok", text: `Saved ${result.data.saved} ${result.data.saved === 1 ? "balance" : "balances"}.` });
      router.refresh();
    });
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        {sheet.years.map((y) => (
          <Link
            key={y.year}
            href={`?year=${y.year}`}
            className={`rounded-full border px-3 py-1 text-sm ${y.year === sheet.year ? "border-brand bg-brand-soft text-brand" : "border-line text-muted hover:text-text"}`}
          >
            {y.label}
          </Link>
        ))}
      </div>

      <details className="rounded-base border border-line bg-surface p-4">
        <summary className="cursor-pointer text-sm font-medium text-text">Paste from your old system</summary>
        <p className="mt-2 text-sm text-muted">
          One line a person and leave type: <span className="font-mono text-xs">email, leave code, carried in, taken</span> — copied from a spreadsheet works too.
          Codes here: {sheet.types.map((t) => t.code).join(", ")}.
        </p>
        <Textarea rows={5} className="mt-2 font-mono text-xs" value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={"asha@yourcompany.com, EL, 8, 3\nasha@yourcompany.com, CL, 0, 2"} disabled={pending} />
        <div className="mt-2">
          <Button type="button" size="sm" variant="secondary" onClick={fillFromPaste} disabled={pending || !paste.trim()}>
            Fill the sheet
          </Button>
        </div>
      </details>

      <div className="overflow-x-auto rounded-base border border-line">
        <table className="min-w-full text-sm">
          <thead className="bg-surface-sunken text-xs text-muted">
            <tr>
              <th rowSpan={2} className="sticky left-0 bg-surface-sunken px-3 py-2 text-left font-medium">
                Person
              </th>
              {sheet.types.map((t) => (
                <th key={t.id} colSpan={2} className="border-l border-line px-3 pt-2 text-center font-medium text-text">
                  {t.name} <span className="text-subtle">({t.code})</span>
                </th>
              ))}
            </tr>
            <tr>
              {sheet.types.map((t) => [
                <th key={`${t.id}-o`} className="border-l border-line px-2 pb-2 text-center font-normal" title="What they carried into the year in the old system. Empty: worked out from last year in Deskzo.">
                  Carried in
                </th>,
                <th key={`${t.id}-u`} className="px-2 pb-2 text-center font-normal" title="Taken this year before Deskzo.">
                  Taken before
                </th>,
              ])}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {sheet.people.map((p) => (
              <tr key={p.id}>
                <td className="sticky left-0 bg-surface px-3 py-1.5">
                  <div className="font-medium text-text">{p.name}</div>
                  <div className="text-xs text-subtle">{p.department ?? p.email}</div>
                </td>
                {sheet.types.map((t) => {
                  const key = keyOf(p.id, t.id);
                  const d = drafts.get(key)!;
                  const cell = p.cells[t.id]!;
                  return [
                    <td key={`${key}-o`} className="border-l border-line px-1.5 py-1.5">
                      <Input
                        inputMode="decimal"
                        aria-label={`${p.name}: ${t.name} carried in`}
                        className="h-8 w-20 text-right"
                        value={d.opening}
                        onChange={(e) => set(key, "opening", e.target.value)}
                        placeholder={cell.opening === null ? "auto" : String(cell.opening)}
                        disabled={pending}
                      />
                    </td>,
                    <td key={`${key}-u`} className="px-1.5 py-1.5">
                      <Input
                        inputMode="decimal"
                        aria-label={`${p.name}: ${t.name} taken before Deskzo`}
                        className="h-8 w-20 text-right"
                        value={d.usedBefore}
                        onChange={(e) => set(key, "usedBefore", e.target.value)}
                        placeholder="0"
                        disabled={pending}
                      />
                    </td>,
                  ];
                })}
              </tr>
            ))}
            {sheet.people.length === 0 && (
              <tr>
                <td colSpan={1 + sheet.types.length * 2} className="px-4 py-8 text-center text-subtle">
                  Nobody employed in {sheet.label}.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="block min-w-64 flex-1 space-y-1.5">
          <span className="text-sm font-medium text-text">Where these came from</span>
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. greytHR balances as of 30 Sep" disabled={pending} />
        </label>
        <Button type="button" onClick={save} disabled={pending || changed.length === 0}>
          {pending ? "Saving…" : changed.length ? `Save ${changed.length} ${changed.length === 1 ? "change" : "changes"}` : "Nothing changed"}
        </Button>
      </div>
      {message && <p className={`text-sm ${message.tone === "ok" ? "text-success" : "text-danger"}`}>{message.text}</p>}
    </div>
  );
}
