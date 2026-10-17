"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Pencil, Trash2 } from "lucide-react";
import { createItemCategory, deleteItemCategory, renameItemCategory } from "@/actions/item-category";
import { Button } from "@/components/ui/button";
import { IconButton, RowActions } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/card";
import { useWording } from "@/components/terms/wording-provider";
import { slot } from "@/lib/terms/dictionary";

export type CategoryRow = { id: string; name: string; items: number };

/**
 * The item categories, with how many items each has — add, rename, delete.
 *
 * Without `catalog.manage` the same list is read-only: the actions refuse anyway, and a pencil that
 * only produces an error is worse than no pencil. A category's count links to the items list filtered
 * to it, which is where its items are moved from before it can go.
 */
export function CategoriesManager({ categories, canManage = true }: { categories: CategoryRow[]; canManage?: boolean }) {
  const router = useRouter();
  // The workspace's own word for an item (Settings → Wording), in the counts.
  const wording = useWording();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [rename, setRename] = useState("");

  function run(action: () => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>, done?: (data: unknown) => void) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      done?.(result.data);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      {error && <p className="text-xs text-danger" role="alert">{error}</p>}
      {notice && <p className="text-xs text-success" role="status">{notice}</p>}

      {canManage && (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const name = draft.trim();
            if (name) run(() => createItemCategory(name), () => setDraft(""));
          }}
        >
          <Input aria-label="New category name" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Add a category — e.g. Laptops, AMC, Software licences" />
          <Button type="submit" size="sm" disabled={!draft.trim() || isPending}>
            Add
          </Button>
        </form>
      )}

      {categories.length === 0 && <p className="text-sm text-subtle">No categories yet.</p>}

      <ul className="divide-y divide-line rounded-md border border-line">
        {categories.map((category) => (
          <li key={category.id} className="flex items-center justify-between gap-2 px-3 py-2">
            {editingId === category.id ? (
              <form
                className="flex flex-1 items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  run(
                    () => renameItemCategory(category.id, rename),
                    (data) => {
                      setEditingId(null);
                      const moved = (data as { items: number }).items;
                      if (moved > 0) setNotice(`Renamed — and on the ${moved} item${moved === 1 ? "" : "s"} in it.`);
                    },
                  );
                }}
              >
                <Input aria-label={`Rename ${category.name}`} value={rename} onChange={(e) => setRename(e.target.value)} autoFocus />
                <Button type="submit" size="sm" disabled={isPending || !rename.trim()}>
                  Save
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setEditingId(null)}>
                  Cancel
                </Button>
              </form>
            ) : (
              <>
                <div className="flex min-w-0 items-center gap-2 text-sm">
                  <span className="truncate font-medium text-text">{category.name}</span>
                  {category.items > 0 ? (
                    <Link href={`/items?category=${encodeURIComponent(category.name)}`} className="hover:underline">
                      <Badge>
                        {category.items}{" "}
                        {category.items === 1 ? slot(wording, "item", "item", "{one:lower}") : slot(wording, "items", "item", "{many:lower}")}
                      </Badge>
                    </Link>
                  ) : (
                    <Badge>{slot(wording, "No items", "item", "No {many:lower}")}</Badge>
                  )}
                </div>
                {canManage && (
                  <RowActions>
                    <IconButton
                      icon={Pencil}
                      label={`Rename ${category.name}`}
                      onClick={() => {
                        setEditingId(category.id);
                        setRename(category.name);
                      }}
                    />
                    <IconButton
                      icon={Trash2}
                      label={`Delete ${category.name}`}
                      tone="danger"
                      disabled={isPending}
                      onClick={() => run(() => deleteItemCategory(category.id))}
                    />
                  </RowActions>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
