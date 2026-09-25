"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Pencil, Plus } from "lucide-react";
import { setCompanyCategory } from "@/actions/customer-category";
import { Dialog } from "@/components/ui/dialog";
import { ActionNotice } from "@/components/ui/action-notice";
import { CategoryChip, CategoryGlyph } from "@/components/customers/category-chip";
import type { CategoryTree, CategoryWithParent, FlatCategory } from "@/lib/customers/categories";
import { cn } from "@/lib/utils";

/**
 * The customer's category chip, and — for whoever can edit the customer — the way to change it: a
 * list of every category and its sub-categories, each with its icon and handling note.
 */
export function CategoryPicker({
  companyId,
  current,
  categories,
  canEdit,
}: {
  companyId: string;
  current: CategoryWithParent | null;
  categories: CategoryTree<FlatCategory>[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const choose = (id: string | null) =>
    startTransition(async () => {
      const result = await setCompanyCategory(companyId, id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      setOpen(false);
      router.refresh();
    });

  if (!canEdit) return <CategoryChip category={current} size="md" />;

  return (
    <>
      {current ? (
        <button type="button" onClick={() => setOpen(true)} className="group inline-flex items-center gap-1" title="Change the category">
          <CategoryChip category={current} size="md" />
          <Pencil className="h-3 w-3 text-subtle opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1 rounded-full border border-dashed border-line-strong px-2 py-0.5 text-xs text-muted hover:text-text"
        >
          <Plus className="h-3 w-3" aria-hidden /> Category
        </button>
      )}

      <Dialog open={open} onClose={() => setOpen(false)} title="Customer category">
        {categories.length === 0 ? (
          <p className="text-sm text-muted">No categories have been set up yet — somebody who manages them can add some in Settings.</p>
        ) : (
          <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-1">
            {categories.map((top) => (
              <div key={top.id}>
                <Option node={top} parent={null} selected={current?.id === top.id} disabled={pending} onChoose={choose} />
                {top.children.length > 0 && (
                  <div className="ml-5 mt-1 space-y-1 border-l border-line pl-3">
                    {top.children.map((child) => (
                      <Option key={child.id} node={child} parent={top} selected={current?.id === child.id} disabled={pending} onChoose={choose} />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        <div className="mt-4 flex items-center justify-between gap-2 border-t border-line pt-3">
          {current ? (
            <button type="button" disabled={pending} onClick={() => choose(null)} className="text-xs text-muted hover:text-danger">
              Take them out of every category
            </button>
          ) : (
            <span />
          )}
          {error && <ActionNotice tone="error">{error}</ActionNotice>}
        </div>
      </Dialog>
    </>
  );
}

function Option({
  node,
  parent,
  selected,
  disabled,
  onChoose,
}: {
  node: FlatCategory;
  parent: FlatCategory | null;
  selected: boolean;
  disabled: boolean;
  onChoose: (id: string) => void;
}) {
  const color = node.color ?? parent?.color ?? "#64748b";
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChoose(node.id)}
      aria-pressed={selected}
      className={cn(
        "flex w-full items-start gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors",
        selected ? "border-brand bg-brand-subtle/40" : "border-transparent hover:bg-surface-sunken",
      )}
    >
      <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full" style={{ color, backgroundColor: `${color}1f` }}>
        <CategoryGlyph icon={node.icon ?? parent?.icon} className="h-3.5 w-3.5" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn("block text-sm text-text", !parent && "font-semibold")}>{node.name}</span>
        {node.guidance && <span className="block truncate text-xs text-subtle">{node.guidance}</span>}
      </span>
      {selected && <Check className="mt-1 h-4 w-4 shrink-0 text-brand" aria-hidden />}
    </button>
  );
}
