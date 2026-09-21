"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  createBrand,
  updateBrand,
  deleteBrand,
  createProductFamily,
  updateProductFamily,
  deleteProductFamily,
} from "@/actions/brand";
import { Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton, RowActions } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/card";

export type BrandRow = {
  id: string;
  name: string;
  _count: { items: number };
  families: { id: string; name: string; _count: { items: number } }[];
};

export function BrandsManager({ brands }: { brands: BrandRow[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [newBrand, setNewBrand] = useState("");
  const [editingBrandId, setEditingBrandId] = useState<string | null>(null);
  const [brandDraft, setBrandDraft] = useState("");
  const [familyDrafts, setFamilyDrafts] = useState<Record<string, string>>({});
  const [editingFamilyId, setEditingFamilyId] = useState<string | null>(null);
  const [familyDraft, setFamilyDraft] = useState("");

  function run(action: () => Promise<{ ok: boolean; error?: string }>, onDone?: () => void) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error ?? "Something went wrong");
        return;
      }
      onDone?.();
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      {error && <p className="text-xs text-danger">{error}</p>}

      <div className="flex items-center gap-2">
        {/* aria-label throughout this file: none of these inputs has a visible label, and the three
            below sit inside a map, so a fixed id would repeat on every row. */}
        <Input
          aria-label="New brand name"
          value={newBrand}
          onChange={(e) => setNewBrand(e.target.value)}
          placeholder="Add a brand — e.g. Microsoft, Adobe, Dell"
        />
        <Button
          type="button"
          size="sm"
          disabled={!newBrand.trim() || isPending}
          onClick={() => run(() => createBrand({ name: newBrand }), () => setNewBrand(""))}
        >
          Add
        </Button>
      </div>

      {brands.length === 0 && <p className="text-sm text-subtle">No brands yet.</p>}

      {brands.map((brand) => (
        <div key={brand.id} className="rounded-md border border-line p-3">
          <div className="flex items-center justify-between gap-2">
            {editingBrandId === brand.id ? (
              <div className="flex flex-1 items-center gap-2">
                <Input
                  aria-label={`Rename ${brand.name}`}
                  value={brandDraft}
                  onChange={(e) => setBrandDraft(e.target.value)}
                />
                <Button
                  type="button"
                  size="sm"
                  disabled={isPending}
                  onClick={() => run(() => updateBrand({ id: brand.id, name: brandDraft }), () => setEditingBrandId(null))}
                >
                  Save
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setEditingBrandId(null)}>
                  Cancel
                </Button>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-medium text-text">{brand.name}</span>
                  <Badge>{brand._count.items} item(s)</Badge>
                </div>
                <RowActions>
                  <IconButton
                    icon={Pencil}
                    label="Rename brand"
                    onClick={() => {
                      setEditingBrandId(brand.id);
                      setBrandDraft(brand.name);
                    }}
                  />
                  <IconButton
                    icon={Trash2}
                    label="Delete brand"
                    tone="danger"
                    disabled={isPending}
                    onClick={() => run(() => deleteBrand(brand.id))}
                  />
                </RowActions>
              </>
            )}
          </div>

          <div className="mt-2 space-y-1.5 border-t border-line pt-2">
            {brand.families.length === 0 && (
              <p className="text-xs text-subtle">No product families yet.</p>
            )}
            {brand.families.map((family) =>
              editingFamilyId === family.id ? (
                <div key={family.id} className="flex items-center gap-2">
                  <Input
                    aria-label={`Rename ${family.name}`}
                    value={familyDraft}
                    onChange={(e) => setFamilyDraft(e.target.value)}
                    className="h-8"
                  />
                  <Button
                    type="button"
                    size="sm"
                    disabled={isPending}
                    onClick={() =>
                      run(() => updateProductFamily({ id: family.id, name: familyDraft }), () => setEditingFamilyId(null))
                    }
                  >
                    Save
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setEditingFamilyId(null)}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <div key={family.id} className="flex items-center justify-between text-sm">
                  <span className="text-text">
                    {family.name} <span className="text-subtle">· {family._count.items} item(s)</span>
                  </span>
                  <RowActions>
                    <IconButton
                      icon={Pencil}
                      label="Rename product family"
                      onClick={() => {
                        setEditingFamilyId(family.id);
                        setFamilyDraft(family.name);
                      }}
                    />
                    <IconButton
                      icon={Trash2}
                      label="Delete product family"
                      tone="danger"
                      disabled={isPending}
                      onClick={() => run(() => deleteProductFamily(family.id))}
                    />
                  </RowActions>
                </div>
              ),
            )}

            <div className="flex items-center gap-2 pt-1">
              <Input
                aria-label={`New ${brand.name} product family`}
                value={familyDrafts[brand.id] ?? ""}
                onChange={(e) => setFamilyDrafts((d) => ({ ...d, [brand.id]: e.target.value }))}
                placeholder={`Add a ${brand.name} family — e.g. Microsoft 365`}
                className="h-8"
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={!(familyDrafts[brand.id] ?? "").trim() || isPending}
                onClick={() =>
                  run(
                    () => createProductFamily({ brandId: brand.id, name: familyDrafts[brand.id] ?? "" }),
                    () => setFamilyDrafts((d) => ({ ...d, [brand.id]: "" })),
                  )
                }
              >
                Add family
              </Button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
