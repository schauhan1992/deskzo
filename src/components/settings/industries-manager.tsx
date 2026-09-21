"use client";

import { useState } from "react";
import { createIndustry, updateIndustry } from "@/actions/industry";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Industry = { id: string; name: string };

function IndustryRow({ industry }: { industry: Industry }) {
  const [name, setName] = useState(industry.name);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = name.trim() !== industry.name && name.trim().length >= 2;

  async function handleSave() {
    setError(null);
    setIsSaving(true);
    const result = await updateIndustry({ id: industry.id, name });
    setIsSaving(false);
    if (!result.ok) {
      setError(result.error);
    }
  }

  return (
    <div className="flex items-start gap-2 py-2">
      <div className="flex-1">
        {/*
          One of these per industry, so the name has to carry the row with it — "Industry name" on
          its own would be announced identically forty times over. Named after the industry as it
          was loaded, not as it is being typed, so it stays the row's identity mid-edit.
        */}
        <Input aria-label={`Rename ${industry.name}`} value={name} onChange={(e) => setName(e.target.value)} />
        {error && <p className="mt-1 text-xs text-danger">{error}</p>}
      </div>
      <Button type="button" variant="secondary" size="sm" disabled={!dirty || isSaving} onClick={handleSave}>
        {isSaving ? "Saving…" : "Save"}
      </Button>
    </div>
  );
}

export function IndustriesManager({ industries }: { industries: Industry[] }) {
  const [list, setList] = useState(industries);
  const [newName, setNewName] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  async function handleAdd() {
    setAddError(null);
    setIsAdding(true);
    const result = await createIndustry({ name: newName });
    setIsAdding(false);
    if (!result.ok) {
      setAddError(result.error);
      return;
    }
    setList((prev) => [...prev, result.data].sort((a, b) => a.name.localeCompare(b.name)));
    setNewName("");
  }

  return (
    <div>
      <div className="space-y-1 divide-y divide-line">
        {list.map((industry) => (
          <IndustryRow key={industry.id} industry={industry} />
        ))}
        {list.length === 0 && <p className="py-2 text-sm text-subtle">No industries yet.</p>}
      </div>

      <div className="mt-3 flex items-start gap-2 border-t border-line pt-3">
        <div className="flex-1">
          <Input
            aria-label="New industry name"
            placeholder="Add a new industry…"
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
