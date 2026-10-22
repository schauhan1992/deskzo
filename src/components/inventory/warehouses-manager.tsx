"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { saveWarehouse } from "@/actions/inventory";
import { Badge } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";
import { qty, rupees } from "@/components/inventory/labels";

type Warehouse = {
  id: string;
  code: string;
  name: string;
  address: string | null;
  isDefault: boolean;
  active: boolean;
  branch: { id: string; name: string } | null;
  quantity: number;
  value: number;
};
type Draft = { id?: string; code: string; name: string; branchId: string; address: string; isDefault: boolean; active: boolean };

const blank: Draft = { code: "", name: "", branchId: "", address: "", isDefault: false, active: true };

/**
 * The warehouses stock is kept in (owner, 22 Oct 2026) — a code, a name, the branch it belongs to, and which
 * one is the default. A warehouse holding stock can't be closed; it's emptied by a transfer first.
 */
export function WarehousesManager({ warehouses, branches, canManage, startNew = false }: { warehouses: Warehouse[]; branches: { id: string; name: string }[]; canManage: boolean; startNew?: boolean }) {
  const router = useRouter();
  const id = useId();
  const [editing, setEditing] = useState<Draft | null>(startNew && canManage ? { ...blank } : null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function save() {
    if (!editing) return;
    setError(null);
    start(async () => {
      const result = await saveWarehouse({ ...editing, branchId: editing.branchId || null, address: editing.address || null });
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
          <Button size="sm" onClick={() => { setError(null); setEditing({ ...blank }); }}>
            <Plus aria-hidden="true" className="h-3.5 w-3.5" /> Add a warehouse
          </Button>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="py-2 pr-3">Code</th>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Branch</th>
              <th className="px-3 py-2 text-right">Quantity on hand</th>
              <th className="px-3 py-2 text-right">Value at cost</th>
              <th className="px-3 py-2">Status</th>
              {canManage && <th className="py-2 pl-3" aria-label="Edit" />}
            </tr>
          </thead>
          <tbody>
            {warehouses.map((w) => (
              <tr key={w.id} className="border-b border-line last:border-0">
                <td className="py-2 pr-3 font-mono text-xs">{w.code}</td>
                <td className="px-3 py-2 text-text">
                  {w.name}
                  {w.address && <div className="text-xs text-subtle">{w.address}</div>}
                </td>
                <td className="px-3 py-2 text-muted">{w.branch?.name ?? "—"}</td>
                <td className="px-3 py-2 text-right tabular-nums">{qty(w.quantity)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{rupees(w.value)}</td>
                <td className="px-3 py-2">
                  <div className="flex gap-1">
                    {w.isDefault && <Badge tone="brand">Default</Badge>}
                    {!w.active && <Badge tone="red">Closed</Badge>}
                  </div>
                </td>
                {canManage && (
                  <td className="py-2 pl-3 text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setError(null);
                        setEditing({ id: w.id, code: w.code, name: w.name, branchId: w.branch?.id ?? "", address: w.address ?? "", isDefault: w.isDefault, active: w.active });
                      }}
                    >
                      Edit
                    </Button>
                  </td>
                )}
              </tr>
            ))}
            {warehouses.length === 0 && (
              <tr>
                <td colSpan={7} className="py-8 text-center text-subtle">
                  No warehouses yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Dialog open={!!editing} onClose={() => setEditing(null)} title={editing?.id ? `Edit ${editing.name}` : "Add a warehouse"}>
        {editing && (
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1">
                <Label htmlFor={`${id}-code`}>Code</Label>
                <Input id={`${id}-code`} value={editing.code} maxLength={12} placeholder="GODOWN-2" onChange={(e) => setEditing({ ...editing, code: e.target.value.toUpperCase() })} />
              </div>
              <div className="col-span-2 space-y-1">
                <Label htmlFor={`${id}-name`}>Name</Label>
                <Input id={`${id}-name`} value={editing.name} maxLength={80} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${id}-branch`}>Branch</Label>
              <Select id={`${id}-branch`} value={editing.branchId} onChange={(e) => setEditing({ ...editing, branchId: e.target.value })}>
                <option value="">None</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-subtle">A branch&apos;s invoices issue stock from its warehouse, where it has one.</p>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${id}-address`}>Address (optional)</Label>
              <Textarea id={`${id}-address`} rows={2} value={editing.address} onChange={(e) => setEditing({ ...editing, address: e.target.value })} />
            </div>
            <label className="flex items-center gap-2 text-sm text-text">
              <input type="checkbox" checked={editing.isDefault} onChange={(e) => setEditing({ ...editing, isDefault: e.target.checked })} />
              The default — where stock goes when nothing says otherwise
            </label>
            {editing.id && (
              <label className="flex items-center gap-2 text-sm text-text">
                <input type="checkbox" checked={editing.active} onChange={(e) => setEditing({ ...editing, active: e.target.checked })} />
                Open (a warehouse holding stock can&apos;t be closed)
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
