"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { saveUnit } from "@/actions/inventory";
import { Badge } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";

type Unit = { id: string; code: string; name: string; decimals: number; active: boolean };
type Draft = { id?: string; code: string; name: string; decimals: number; active: boolean };

/** Units of measure (owner, 22 Oct 2026): the GST portal's quantity codes, and any of the company's own. */
export function UnitsManager({ units, canManage, startNew = false }: { units: Unit[]; canManage: boolean; startNew?: boolean }) {
  const router = useRouter();
  const id = useId();
  const [editing, setEditing] = useState<Draft | null>(startNew && canManage ? { code: "", name: "", decimals: 0, active: true } : null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function save() {
    if (!editing) return;
    setError(null);
    start(async () => {
      const result = await saveUnit(editing);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setEditing(null);
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      {canManage && (
        <div className="flex justify-end">
          <Button size="sm" onClick={() => { setError(null); setEditing({ code: "", name: "", decimals: 0, active: true }); }}>
            <Plus aria-hidden="true" className="h-3.5 w-3.5" /> Add a unit
          </Button>
        </div>
      )}
      <table className="w-full text-sm">
        <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
          <tr>
            <th className="py-2 pr-3">Code</th>
            <th className="px-3 py-2">Name</th>
            <th className="px-3 py-2 text-right">Decimals</th>
            <th className="px-3 py-2">Status</th>
            {canManage && <th className="py-2 pl-3" aria-label="Edit" />}
          </tr>
        </thead>
        <tbody>
          {units.map((u) => (
            <tr key={u.id} className="border-b border-line last:border-0">
              <td className="py-2 pr-3 font-mono text-xs">{u.code}</td>
              <td className="px-3 py-2 text-text">{u.name}</td>
              <td className="px-3 py-2 text-right tabular-nums text-muted">{u.decimals}</td>
              <td className="px-3 py-2">{!u.active && <Badge tone="red">Not in use</Badge>}</td>
              {canManage && (
                <td className="py-2 pl-3 text-right">
                  <Button size="sm" variant="ghost" onClick={() => { setError(null); setEditing({ ...u }); }}>
                    Edit
                  </Button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      <Dialog open={!!editing} onClose={() => setEditing(null)} title={editing?.id ? `Edit ${editing.code}` : "Add a unit"}>
        {editing && (
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1">
                <Label htmlFor={`${id}-code`}>Code</Label>
                <Input id={`${id}-code`} value={editing.code} maxLength={8} placeholder="BOX" onChange={(e) => setEditing({ ...editing, code: e.target.value.toUpperCase() })} />
              </div>
              <div className="col-span-2 space-y-1">
                <Label htmlFor={`${id}-name`}>Name</Label>
                <Input id={`${id}-name`} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${id}-dec`}>Decimals a quantity takes</Label>
              <Select id={`${id}-dec`} value={String(editing.decimals)} onChange={(e) => setEditing({ ...editing, decimals: Number(e.target.value) })}>
                <option value="0">0 — whole units</option>
                <option value="1">1</option>
                <option value="2">2</option>
                <option value="3">3 — e.g. kilograms to the gram</option>
              </Select>
            </div>
            {editing.id && (
              <label className="flex items-center gap-2 text-sm text-text">
                <input type="checkbox" checked={editing.active} onChange={(e) => setEditing({ ...editing, active: e.target.checked })} />
                In use
              </label>
            )}
            {error && <ActionNotice tone="error">{error}</ActionNotice>}
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button disabled={pending} onClick={save}>
                {pending ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}
