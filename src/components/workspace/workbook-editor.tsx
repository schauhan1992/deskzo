"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Save, Trash2 } from "lucide-react";
import { deleteWorkbook, saveWorkbook, type workbookFilterOptions } from "@/actions/workspace";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { FilterBuilder } from "@/components/workspace/filter-builder";
import type { WorkbookFilters } from "@/lib/workspace/filters";

type Options = Awaited<ReturnType<typeof workbookFilterOptions>>;

/**
 * Building or editing a saved list.
 *
 * Filters live in component state rather than the URL: a list is built by toggling twenty things
 * and the URL would become unreadable, and there's a Save button for the case where it needs to be
 * kept. Opening an existing list starts from its stored filters, so changing one and saving is an
 * edit rather than a new list.
 */
export function WorkbookEditor({
  options,
  workbook,
}: {
  options: Options;
  workbook?: {
    id: string;
    name: string;
    description: string | null;
    filters: WorkbookFilters;
    shared: boolean;
    canEdit: boolean;
  };
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [filters, setFilters] = useState<WorkbookFilters>(workbook?.filters ?? {});
  const [name, setName] = useState(workbook?.name ?? "");
  const [description, setDescription] = useState(workbook?.description ?? "");
  const [shared, setShared] = useState(workbook?.shared ?? true);

  function save() {
    setError(null);
    startTransition(async () => {
      const result = await saveWorkbook({ id: workbook?.id, name, description, filters, shared });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push(`/workspace/${result.data.id}`);
      router.refresh();
    });
  }

  function remove() {
    if (!workbook) return;
    if (!confirm(`Delete "${workbook.name}"? The companies in it aren't affected — only the saved list.`)) return;
    setError(null);
    startTransition(async () => {
      const result = await deleteWorkbook(workbook.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push("/workspace");
      router.refresh();
    });
  }

  return (
    <div className="@container space-y-4">
      <Card>
        <CardContent className="space-y-3 py-4">
          <div className="grid grid-cols-1 gap-3 @2xl:grid-cols-[1fr_2fr]">
            <div className="space-y-1.5">
              <Label htmlFor="wbName">
                List name <span className="text-danger">*</span>
              </Label>
              <Input
                id="wbName"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Maharashtra, no order in 90 days"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="wbDescription">What it&apos;s for</Label>
              <Textarea
                id="wbDescription"
                rows={2}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Who should work this list, and what they should do with it"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-sm text-text">
              <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
              Everyone can see this list
              <span className="text-xs text-subtle">(only you can change it)</span>
            </label>

            <div className="flex items-center gap-2">
              {workbook?.canEdit && (
                <Button variant="ghost" disabled={pending} onClick={remove} className="text-danger">
                  <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                  Delete
                </Button>
              )}
              <Button disabled={pending || !name.trim()} onClick={save}>
                <Save className="mr-1.5 h-3.5 w-3.5" />
                {pending ? "Saving…" : workbook ? "Save changes" : "Save list"}
              </Button>
            </div>
          </div>

          {error && <p className="text-sm text-danger">{error}</p>}
        </CardContent>
      </Card>

      <FilterBuilder filters={filters} onChange={setFilters} options={options} />
    </div>
  );
}
