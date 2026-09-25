"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from "lucide-react";
import { deleteCustomerCategory, moveCustomerCategory, saveCustomerCategory, type CategoryOption } from "@/actions/customer-category";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";
import { CategoryChip, CategoryGlyph } from "@/components/customers/category-chip";
import { CATEGORY_COLORS, CATEGORY_ICONS } from "@/lib/customers/category-icons";
import { MAX_CATEGORY_GUIDANCE, MAX_CATEGORY_NAME, type CategoryTree } from "@/lib/customers/categories";
import { cn } from "@/lib/utils";

type Draft = { id?: string; parentId: string | null; name: string; icon: string | null; color: string | null; guidance: string };
type Notice = { tone: "success" | "error"; text: string } | null;

/**
 * The categories and their sub-categories, in the order the pickers show them — and everything about
 * each: its icon and colour, what it is called, and how to treat the customers in it.
 */
export function CategoriesManager({ categories }: { categories: CategoryTree<CategoryOption>[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  const run = (work: () => Promise<{ ok: true } | { ok: false; error: string }>, done?: string) =>
    startTransition(async () => {
      const result = await work();
      setNotice(result.ok ? (done ? { tone: "success", text: done } : null) : { tone: "error", text: result.error });
      if (result.ok) router.refresh();
    });

  const remove = (node: CategoryOption, parent: CategoryTree<CategoryOption> | null) => {
    const top = parent ? null : categories.find((c) => c.id === node.id);
    const inIt = top ? top.customers + top.children.reduce((t, c) => t + c.customers, 0) : node.customers;
    const message = parent
      ? `Delete “${node.name}”?${inIt ? ` Its ${inIt} customer${inIt === 1 ? "" : "s"} move up to “${parent.name}”.` : ""}`
      : `Delete “${node.name}”${top?.children.length ? ` and its ${top.children.length} sub-categor${top.children.length === 1 ? "y" : "ies"}` : ""}?${inIt ? ` ${inIt} customer${inIt === 1 ? "" : "s"} will have no category.` : ""}`;
    if (!window.confirm(message)) return;
    run(async () => {
      const r = await deleteCustomerCategory(node.id);
      return r.ok ? { ok: true } : r;
    }, "Deleted.");
  };

  return (
    <div className="space-y-3">
      {categories.length === 0 && <p className="text-sm text-muted">No categories yet. Add the first one below.</p>}
      {categories.map((top, i) => (
        <div key={top.id} className="rounded-xl border border-line">
          <Row
            node={top}
            parent={null}
            count={top.customers + top.children.reduce((t, c) => t + c.customers, 0)}
            first={i === 0}
            last={i === categories.length - 1}
            disabled={pending}
            onEdit={() => setDraft({ id: top.id, parentId: null, name: top.name, icon: top.icon, color: top.color, guidance: top.guidance ?? "" })}
            onMove={(d) => run(async () => { const r = await moveCustomerCategory(top.id, d); return r.ok ? { ok: true } : r; })}
            onDelete={() => remove(top, null)}
          />
          <div className="space-y-px border-t border-line bg-surface-sunken/40 py-1 pl-8 pr-2">
            {top.children.map((child, j) => (
              <Row
                key={child.id}
                node={child}
                parent={top}
                count={child.customers}
                first={j === 0}
                last={j === top.children.length - 1}
                disabled={pending}
                onEdit={() => setDraft({ id: child.id, parentId: top.id, name: child.name, icon: child.icon, color: child.color, guidance: child.guidance ?? "" })}
                onMove={(d) => run(async () => { const r = await moveCustomerCategory(child.id, d); return r.ok ? { ok: true } : r; })}
                onDelete={() => remove(child, top)}
              />
            ))}
            <button
              type="button"
              onClick={() => setDraft({ parentId: top.id, name: "", icon: null, color: null, guidance: "" })}
              className="inline-flex items-center gap-1 px-2 py-1.5 text-xs text-brand hover:underline"
            >
              <Plus className="h-3 w-3" aria-hidden /> Sub-category under {top.name}
            </button>
          </div>
        </div>
      ))}

      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" onClick={() => setDraft({ parentId: null, name: "", icon: "star", color: CATEGORY_COLORS[0], guidance: "" })}>
          <Plus className="h-3.5 w-3.5" /> Add a category
        </Button>
        {notice && <ActionNotice tone={notice.tone}>{notice.text}</ActionNotice>}
      </div>

      {draft && (
        <Editor
          draft={draft}
          parent={draft.parentId ? (categories.find((c) => c.id === draft.parentId) ?? null) : null}
          pending={pending}
          onClose={() => setDraft(null)}
          onSave={(d) =>
            run(async () => {
              const r = await saveCustomerCategory({ id: d.id, parentId: d.parentId, name: d.name, icon: d.icon, color: d.color, guidance: d.guidance || null });
              if (r.ok) setDraft(null);
              return r.ok ? { ok: true } : r;
            }, "Saved.")
          }
        />
      )}
    </div>
  );
}

function Row({
  node,
  parent,
  count,
  first,
  last,
  disabled,
  onEdit,
  onMove,
  onDelete,
}: {
  node: CategoryOption;
  parent: CategoryOption | null;
  count: number;
  first: boolean;
  last: boolean;
  disabled: boolean;
  onEdit: () => void;
  onMove: (direction: "up" | "down") => void;
  onDelete: () => void;
}) {
  const color = node.color ?? parent?.color ?? "#64748b";
  return (
    <div className={cn("flex items-start gap-3", parent ? "rounded-lg px-2 py-2 hover:bg-surface" : "px-3 py-3")}>
      <span className={cn("grid shrink-0 place-items-center rounded-full", parent ? "h-7 w-7" : "h-9 w-9")} style={{ color, backgroundColor: `${color}1f` }}>
        <CategoryGlyph icon={node.icon ?? parent?.icon} className={parent ? "h-3.5 w-3.5" : "h-4.5 w-4.5"} aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className={cn("text-text", parent ? "text-sm" : "text-sm font-semibold")}>{node.name}</span>
          <span className="text-xs text-subtle">
            {count} customer{count === 1 ? "" : "s"}
          </span>
        </div>
        {node.guidance ? <p className="mt-0.5 text-xs text-muted">{node.guidance}</p> : <p className="mt-0.5 text-xs italic text-subtle">No handling note.</p>}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <IconButton label={`Move ${node.name} up`} disabled={disabled || first} onClick={() => onMove("up")}>
          <ArrowUp className="h-3.5 w-3.5" />
        </IconButton>
        <IconButton label={`Move ${node.name} down`} disabled={disabled || last} onClick={() => onMove("down")}>
          <ArrowDown className="h-3.5 w-3.5" />
        </IconButton>
        <IconButton label={`Edit ${node.name}`} disabled={disabled} onClick={onEdit}>
          <Pencil className="h-3.5 w-3.5" />
        </IconButton>
        <IconButton label={`Delete ${node.name}`} disabled={disabled} onClick={onDelete} danger>
          <Trash2 className="h-3.5 w-3.5" />
        </IconButton>
      </div>
    </div>
  );
}

function IconButton({ label, disabled, onClick, danger, children }: { label: string; disabled: boolean; onClick: () => void; danger?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn("rounded-md p-1.5 text-subtle hover:bg-surface-sunken disabled:opacity-30", danger ? "hover:text-danger" : "hover:text-text")}
    >
      {children}
    </button>
  );
}

function Editor({
  draft,
  parent,
  pending,
  onClose,
  onSave,
}: {
  draft: Draft;
  parent: CategoryOption | null;
  pending: boolean;
  onClose: () => void;
  onSave: (d: Draft) => void;
}) {
  const [d, setD] = useState(draft);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setD((v) => ({ ...v, [key]: value }));
  const isSub = !!d.parentId;
  const preview = {
    id: "preview",
    name: d.name || (isSub ? "Sub-category" : "Category"),
    icon: d.icon,
    color: d.color,
    guidance: d.guidance || null,
    parent: parent ? { id: parent.id, name: parent.name, icon: parent.icon, color: parent.color, guidance: parent.guidance } : null,
  };

  return (
    <Dialog open onClose={onClose} title={d.id ? `Edit ${draft.name}` : isSub ? `New sub-category under ${parent?.name ?? ""}` : "New category"}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(d);
        }}
      >
        <div className="flex items-center gap-2 rounded-lg bg-surface-sunken px-3 py-2">
          <span className="text-xs text-muted">Beside a customer&apos;s name:</span>
          <CategoryChip category={preview} size="md" />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="category-name">Name</Label>
          <Input id="category-name" autoFocus maxLength={MAX_CATEGORY_NAME} value={d.name} onChange={(e) => set("name", e.target.value)} placeholder={isSub ? "e.g. Key account" : "e.g. Strategic"} />
        </div>

        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-text">Icon</legend>
          <div className="grid grid-cols-8 gap-1 sm:grid-cols-12">
            {isSub && (
              <button
                type="button"
                onClick={() => set("icon", null)}
                aria-pressed={d.icon === null}
                title={`Same as ${parent?.name ?? "its category"}`}
                className={cn("col-span-2 rounded-md border px-1 py-1.5 text-[10px] text-muted", d.icon === null ? "border-brand bg-brand-subtle/40 text-text" : "border-line hover:bg-surface-sunken")}
              >
                Same as {parent?.name}
              </button>
            )}
            {Object.entries(CATEGORY_ICONS).map(([key, { Icon, label }]) => (
              <button
                key={key}
                type="button"
                onClick={() => set("icon", key)}
                aria-label={label}
                aria-pressed={d.icon === key}
                title={label}
                className={cn("grid place-items-center rounded-md border py-1.5", d.icon === key ? "border-brand bg-brand-subtle/40 text-text" : "border-transparent text-muted hover:bg-surface-sunken")}
              >
                <Icon className="h-4 w-4" />
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-text">Colour</legend>
          <div className="flex flex-wrap items-center gap-1.5">
            {isSub && (
              <button
                type="button"
                onClick={() => set("color", null)}
                aria-pressed={d.color === null}
                className={cn("rounded-full border px-2 py-1 text-[10px] text-muted", d.color === null ? "border-brand text-text" : "border-line")}
              >
                Same as {parent?.name}
              </button>
            )}
            {CATEGORY_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => set("color", c)}
                aria-label={`Colour ${c}`}
                aria-pressed={d.color === c}
                className={cn("h-7 w-7 rounded-full ring-offset-2 ring-offset-surface", d.color === c && "ring-2 ring-brand")}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </fieldset>

        <div className="space-y-1.5">
          <Label htmlFor="category-guidance">How to treat them</Label>
          <Textarea
            id="category-guidance"
            rows={3}
            maxLength={MAX_CATEGORY_GUIDANCE}
            value={d.guidance}
            onChange={(e) => set("guidance", e.target.value)}
            placeholder={isSub ? "What is true of these on top of the category's note — e.g. reply within four hours." : "e.g. Our most important accounts. Every quote is checked before it goes."}
          />
          <p className="text-xs text-subtle">Shown under the customer&apos;s name on their page{isSub ? `, after ${parent?.name ?? "the category"}'s note` : ""}.</p>
        </div>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={pending || !d.name.trim()}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
