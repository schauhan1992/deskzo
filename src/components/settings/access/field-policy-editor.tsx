"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Search } from "lucide-react";
import { setRoleFieldAccess, setRoleUnmaskLimit, type FieldAccessRow, type RoleFieldAccess } from "@/actions/field-access";
import { MASK_FORMAT_LABELS, maskValue, normalisePolicy, type FieldKind, type FieldPolicy, type MaskFormat } from "@/lib/authz/field-policy";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";
import { Switch } from "@/components/settings/access/switch";

/**
 * A role's Field Permissions (src/actions/field-access.ts): per field, whether it can be read at all,
 * whether it is masked in lists and on the lead, whether a masked value may be unmasked, and how it is
 * masked — and the role's daily unmask limit beneath. One person's are on their Permissions and Field
 * Permissions tabs under Users (src/components/settings/people/person-permissions-panel.tsx).
 *
 * What the switches mean, and the one rule the screen keeps before the server does: a field that can't
 * be read has nothing to mask or unmask, so its other switches go off with it.
 */

const SAMPLE: Record<FieldKind, string> = {
  text: "Acme Technologies",
  email: "sales@globex.com",
  phone: "+91 98765 43210",
  address: "12 MG Road, Pune",
  choice: "Website",
};

type Choice = FieldPolicy | null;

function effectiveWords(p: FieldPolicy): { text: string; tone: "green" | "amber" | "red" | "blue" } {
  if (!p.view) return { text: "Restricted", tone: "red" };
  if (!p.maskInList && !p.maskInDetail) return { text: "Visible", tone: "green" };
  return { text: p.unmask ? "Masked · may unmask" : "Masked", tone: p.unmask ? "blue" : "amber" };
}

export function FieldPolicyEditor(props: { role: string; data: RoleFieldAccess; canEdit: boolean; lockedWhy: string | null }) {
  const router = useRouter();
  const rows = props.data.rows;
  const [choices, setChoices] = useState<Map<string, Choice>>(() => new Map(rows.map((r) => [r.key, r.stored])));
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [pending, start] = useTransition();

  const dirty = rows.filter((r) => JSON.stringify(choices.get(r.key) ?? null) !== JSON.stringify(r.stored));
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? rows.filter((r) => r.label.toLowerCase().includes(q) || r.description.toLowerCase().includes(q)) : rows;
  }, [rows, search]);

  const set = (row: FieldAccessRow, next: Choice) => {
    setNotice(null);
    setChoices((m) => new Map(m).set(row.key, next === null ? null : normalisePolicy(row.kind, next)));
  };
  const policyOf = (row: FieldAccessRow): FieldPolicy => choices.get(row.key) ?? row.inherited;
  const edit = (row: FieldAccessRow, patch: Partial<FieldPolicy>) => set(row, { ...policyOf(row), ...patch });

  const save = () =>
    start(async () => {
      setNotice(null);
      const changes = dirty.map((r) => ({ field: r.key, policy: choices.get(r.key) ?? null }));
      const result = await setRoleFieldAccess(props.role, changes);
      if (!result.ok) {
        setNotice({ tone: "error", text: result.error });
        return;
      }
      setNotice({ tone: "success", text: result.data.changed === 0 ? "Nothing to save." : `Saved ${result.data.changed} field${result.data.changed === 1 ? "" : "s"}.` });
      router.refresh();
    });

  const locked = !props.canEdit;

  return (
    <div className="space-y-4">
      {props.lockedWhy && <p className="rounded-base border border-line bg-surface-sunken px-3 py-2 text-sm text-muted">{props.lockedWhy}</p>}
      {props.data.warnings.length > 0 && (
        <div className="space-y-1.5 rounded-base border border-warning/40 bg-warning-bg px-3 py-2 text-sm text-text">
          {props.data.warnings.map((w) => (
            <p key={w} className="flex gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
              {w}
            </p>
          ))}
        </div>
      )}

      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-text">Sensitive field masking — Leads</h3>
            <p className="mt-0.5 text-xs text-muted">What everybody in this role sees of each field. Nothing set is visible and unmasked, as before.</p>
          </div>
          <label className="relative block w-56">
            <span className="sr-only">Search fields</span>
            <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-subtle" aria-hidden />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search fields…" className="h-8 pl-8 text-sm" />
          </label>
        </CardHeader>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[600px] text-sm">
            <thead className="border-y border-line bg-surface-sunken text-left text-xs font-medium text-muted">
              <tr>
                <th className="px-3 py-2">Field · effective</th>
                <th className="px-2 py-2">View</th>
                <th className="px-2 py-2">Mask in list</th>
                <th className="px-2 py-2">Mask in detail</th>
                <th className="px-2 py-2">Unmask</th>
                <th className="px-2 py-2">Format</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => {
                const p = policyOf(row);
                const rowLocked = locked;
                const eff = effectiveWords(p);
                const preview = p.view ? maskValue(SAMPLE[row.kind], p.format) : "Restricted";
                return (
                  <tr key={row.key} className="border-b border-line last:border-0">
                    <td className="px-3 py-2.5">
                      <span className="font-medium text-text">{row.label}</span>
                      {row.custom && <Badge className="ml-1.5">Custom</Badge>}
                      <span className="block text-xs text-subtle">{row.description}</span>
                      <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <Badge tone={eff.tone}>{eff.text}</Badge>
                        <span className="text-[11px] text-subtle">{row.why}</span>
                      </span>
                    </td>
                    <td className="px-2 py-2.5">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-[var(--color-brand)]"
                        checked={p.view}
                        disabled={rowLocked}
                        aria-label={`${row.label}: may be read`}
                        onChange={(e) => edit(row, { view: e.target.checked })}
                      />
                    </td>
                    <td className="px-2 py-2.5">
                      <Switch label={`${row.label}: masked in lists`} checked={p.maskInList} disabled={rowLocked || !p.view} onChange={(v) => edit(row, { maskInList: v })} />
                    </td>
                    <td className="px-2 py-2.5">
                      <Switch label={`${row.label}: masked on the lead`} checked={p.maskInDetail} disabled={rowLocked || !p.view} onChange={(v) => edit(row, { maskInDetail: v })} />
                    </td>
                    <td className="px-2 py-2.5">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-[var(--color-brand)]"
                        checked={p.unmask}
                        disabled={rowLocked || !p.view || (!p.maskInList && !p.maskInDetail)}
                        aria-label={`${row.label}: may unmask`}
                        onChange={(e) => edit(row, { unmask: e.target.checked })}
                      />
                    </td>
                    <td className="px-2 py-2.5">
                      <Select
                        value={p.format}
                        disabled={rowLocked || !p.view}
                        aria-label={`${row.label}: mask format`}
                        onChange={(e) => edit(row, { format: e.target.value as MaskFormat })}
                        className="h-8 min-w-[7.5rem] text-xs"
                      >
                        {row.formats.map((f) => (
                          <option key={f} value={f}>
                            {MASK_FORMAT_LABELS[f]}
                          </option>
                        ))}
                      </Select>
                      <span className="mt-1 block font-mono text-[11px] text-subtle">{preview}</span>
                    </td>
                  </tr>
                );
              })}
              {shown.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center text-subtle">
                    No field matches “{search}”.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {!locked && (
          <CardContent className="flex flex-wrap items-end justify-between gap-3 border-t border-line pt-4">
            <span className="text-xs text-subtle">Changes apply to everybody in this role on their next page.</span>
            <div className="flex items-center gap-2">
              {dirty.length > 0 && (
                <Button variant="ghost" size="sm" onClick={() => setChoices(new Map(rows.map((r) => [r.key, r.stored])))} disabled={pending}>
                  Discard
                </Button>
              )}
              <Button size="sm" onClick={save} disabled={pending || dirty.length === 0}>
                {pending ? "Saving…" : dirty.length ? `Save ${dirty.length} change${dirty.length === 1 ? "" : "s"}` : "Save changes"}
              </Button>
            </div>
          </CardContent>
        )}
        {notice && (
          <div className="px-4 pb-4">
            <ActionNotice tone={notice.tone}>{notice.text}</ActionNotice>
          </div>
        )}
      </Card>

      <RoleLimit role={props.role} dailyLimit={props.data.dailyLimit} canEdit={props.canEdit} />
    </div>
  );
}

const PRESETS = [10, 25, 50, 100];

function RoleLimit({ role, dailyLimit, canEdit }: { role: string; dailyLimit: number | null; canEdit: boolean }) {
  const router = useRouter();
  const [value, setValue] = useState(dailyLimit === null ? "" : String(dailyLimit));
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [pending, start] = useTransition();
  const save = () =>
    start(async () => {
      const result = await setRoleUnmaskLimit(role, value.trim() === "" ? null : value);
      setNotice(result.ok ? { tone: "success", text: "Saved." } : { tone: "error", text: result.error });
      if (result.ok) router.refresh();
    });
  return (
    <Card>
      <CardHeader>
        <h3 className="text-sm font-semibold text-text">Unmasking limit (daily)</h3>
        <p className="mt-0.5 text-xs text-muted">
          How many different leads each person in this role may unmask in one day. Unmasking a lead&apos;s email, phone and company together counts once; opening
          it again the same day counts nothing. Blank is no limit.
        </p>
      </CardHeader>
      <CardContent className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="role-limit" className="text-xs">
            Leads a day
          </Label>
          <Input id="role-limit" inputMode="numeric" value={value} disabled={!canEdit} onChange={(e) => setValue(e.target.value.replace(/\D/g, ""))} placeholder="No limit" className="h-8 w-32 text-sm" />
        </div>
        {canEdit && (
          <>
            <div className="flex gap-1.5">
              {PRESETS.map((n) => (
                <button key={n} type="button" onClick={() => setValue(String(n))} className="h-8 rounded-base border border-line px-2.5 text-xs text-muted hover:bg-surface-sunken">
                  {n}
                </button>
              ))}
            </div>
            <Button size="sm" onClick={save} disabled={pending}>
              {pending ? "Saving…" : "Save limit"}
            </Button>
          </>
        )}
        {notice && <ActionNotice tone={notice.tone}>{notice.text}</ActionNotice>}
      </CardContent>
    </Card>
  );
}
