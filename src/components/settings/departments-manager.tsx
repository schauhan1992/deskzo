"use client";

import { useState, useTransition } from "react";
import {
  createDepartment,
  updateDepartment,
  deleteDepartment,
  setDepartmentSupportTeam,
  setDepartmentDashboardWidgets,
} from "@/actions/department";
import { DASHBOARD_WIDGET_REGISTRY } from "@/lib/dashboard-widgets";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";

type Department = {
  id: string;
  name: string;
  isSupportTeam: boolean;
  defaultDashboardWidgets: string[];
  _count: { members: number };
};

function DashboardWidgetsDialog({
  department,
  onClose,
  onSaved,
}: {
  department: Department;
  onClose: () => void;
  onSaved: (widgets: string[]) => void;
}) {
  const [checkedKeys, setCheckedKeys] = useState<Set<string>>(new Set(department.defaultDashboardWidgets));
  const [isPending, startTransition] = useTransition();

  function toggle(key: string) {
    setCheckedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function handleSave() {
    startTransition(async () => {
      const widgets = Array.from(checkedKeys);
      await setDepartmentDashboardWidgets(department.id, widgets);
      onSaved(widgets);
      onClose();
    });
  }

  return (
    <Dialog open onClose={onClose} title={`Dashboard layout — ${department.name}`}>
      <p className="text-sm text-muted">
        Choose the widgets offered to this department&apos;s members as a one-click predefined dashboard layout. Leave
        everything unchecked to offer no predefined layout for this department.
      </p>
      <div className="mt-3 max-h-80 space-y-1 overflow-y-auto">
        {DASHBOARD_WIDGET_REGISTRY.map((widget) => (
          <label key={widget.key} className="flex items-start gap-2.5 rounded-md px-2 py-2 hover:bg-surface-sunken">
            <input
              type="checkbox"
              checked={checkedKeys.has(widget.key)}
              onChange={() => toggle(widget.key)}
              className="mt-0.5 h-4 w-4 rounded border-line-strong"
            />
            <span>
              <span className="block text-sm font-medium text-text">{widget.label}</span>
              <span className="block text-xs text-muted">{widget.description}</span>
            </span>
          </label>
        ))}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={isPending}>
          Cancel
        </Button>
        <Button type="button" size="sm" onClick={handleSave} disabled={isPending}>
          {isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </Dialog>
  );
}

function DepartmentRow({
  department,
  onDeleted,
  onChanged,
}: {
  department: Department;
  onDeleted: (id: string) => void;
  onChanged: (id: string, patch: Partial<Department>) => void;
}) {
  const [name, setName] = useState(department.name);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isTogglingSupport, startSupportTransition] = useTransition();
  const [showWidgetsDialog, setShowWidgetsDialog] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = name.trim() !== department.name && name.trim().length >= 2;

  async function handleSave() {
    setError(null);
    setIsSaving(true);
    const result = await updateDepartment({ id: department.id, name });
    setIsSaving(false);
    if (!result.ok) {
      setError(result.error);
    }
  }

  function handleToggleSupportTeam() {
    setError(null);
    const next = !department.isSupportTeam;
    startSupportTransition(async () => {
      const result = await setDepartmentSupportTeam(department.id, next);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onChanged(department.id, { isSupportTeam: next });
    });
  }

  async function handleDelete() {
    if (department._count.members > 0) return;
    setError(null);
    setIsDeleting(true);
    const result = await deleteDepartment(department.id);
    setIsDeleting(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onDeleted(department.id);
  }

  return (
    <div className="flex flex-wrap items-start gap-2 py-2">
      <div className="min-w-48 flex-1 basis-48">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label={`Department name — ${department.name}`}
        />
        {error && <p className="mt-1 text-xs text-danger">{error}</p>}
      </div>
      <span className="mt-2.5 shrink-0 text-xs text-subtle">
        {department._count.members} {department._count.members === 1 ? "member" : "members"}
      </span>
      <label className="mt-2 flex shrink-0 items-center gap-1.5 text-xs text-muted">
        <input
          type="checkbox"
          checked={department.isSupportTeam}
          disabled={isTogglingSupport}
          onChange={handleToggleSupportTeam}
          className="h-3.5 w-3.5"
        />
        Ticket assignment
      </label>
      <Button type="button" variant="secondary" size="sm" disabled={!dirty || isSaving} onClick={handleSave}>
        {isSaving ? "Saving…" : "Save"}
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={() => setShowWidgetsDialog(true)}>
        Dashboard{department.defaultDashboardWidgets.length > 0 ? ` (${department.defaultDashboardWidgets.length})` : ""}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={department._count.members > 0 || isDeleting}
        title={department._count.members > 0 ? "Move members out before deleting" : undefined}
        onClick={handleDelete}
      >
        {isDeleting ? "Deleting…" : "Delete"}
      </Button>

      {showWidgetsDialog && (
        <DashboardWidgetsDialog
          department={department}
          onClose={() => setShowWidgetsDialog(false)}
          onSaved={(widgets) => onChanged(department.id, { defaultDashboardWidgets: widgets })}
        />
      )}
    </div>
  );
}

export function DepartmentsManager({ departments }: { departments: Department[] }) {
  const [list, setList] = useState(departments);
  const [newName, setNewName] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  async function handleAdd() {
    setAddError(null);
    setIsAdding(true);
    const result = await createDepartment({ name: newName });
    setIsAdding(false);
    if (!result.ok) {
      setAddError(result.error);
      return;
    }
    setList((prev) =>
      [...prev, { ...result.data, isSupportTeam: false, defaultDashboardWidgets: [], _count: { members: 0 } }].sort(
        (a, b) => a.name.localeCompare(b.name),
      ),
    );
    setNewName("");
  }

  return (
    <div>
      <p className="mb-2 text-xs text-subtle">
        Check &ldquo;Ticket assignment&rdquo; for the department(s) whose members can be assigned support tickets.
      </p>
      <div className="space-y-1 divide-y divide-line">
        {list.map((department) => (
          <DepartmentRow
            key={department.id}
            department={department}
            onDeleted={(id) => setList((prev) => prev.filter((d) => d.id !== id))}
            onChanged={(id, patch) => setList((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)))}
          />
        ))}
        {list.length === 0 && <p className="py-2 text-sm text-subtle">No departments yet.</p>}
      </div>

      <div className="mt-3 flex flex-wrap items-start gap-2 border-t border-line pt-3">
        <div className="min-w-48 flex-1 basis-48">
          <Input
            aria-label="New department"
            placeholder="Add a new department…"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          {addError && <p className="mt-1 text-xs text-danger">{addError}</p>}
        </div>
        <Button type="button" size="sm" disabled={newName.trim().length < 2 || isAdding} onClick={handleAdd}>
          {isAdding ? "Adding…" : "Add"}
        </Button>
      </div>
    </div>
  );
}
