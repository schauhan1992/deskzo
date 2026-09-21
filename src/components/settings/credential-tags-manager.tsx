"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import type { CredentialTagKind } from "@prisma/client";
import { deleteCredentialTag, saveCredentialTag } from "@/actions/vault";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { IconButton } from "@/components/ui/icon-button";
import { Checkbox } from "@/components/ui/bulk-select";

type Tag = { id: string; kind: CredentialTagKind; name: string; active: boolean };

/**
 * The two lists the vault files credentials under.
 *
 * Both are rows rather than enums because both grow — the day somebody signs up for a new kind of
 * portal, an enum would mean a migration, which in practice means it gets filed under "Other".
 */
export function CredentialTagsManager({ tags }: { tags: Tag[] }) {
  return (
    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
      <Column
        kind="CATEGORY"
        title="Categories"
        hint="What kind of service it is."
        placeholder="Hosting"
        tags={tags.filter((t) => t.kind === "CATEGORY")}
      />
      <Column
        kind="ACCESS_TYPE"
        title="Access types"
        hint="What kind of access the login grants."
        placeholder="Billing"
        tags={tags.filter((t) => t.kind === "ACCESS_TYPE")}
      />
    </div>
  );
}

function Column({
  kind,
  title,
  hint,
  placeholder,
  tags,
}: {
  kind: CredentialTagKind;
  title: string;
  hint: string;
  placeholder: string;
  tags: Tag[];
}) {
  const router = useRouter();
  const [adding, setAdding] = useState("");
  const [pending, startTransition] = useTransition();

  return (
    <div className="space-y-2">
      <div>
        <h3 className="text-sm font-medium text-text">{title}</h3>
        <p className="text-xs text-subtle">{hint}</p>
      </div>

      {tags.length === 0 && <p className="py-2 text-sm text-muted">None yet.</p>}

      {tags.map((t) => (
        <div key={t.id} className="flex items-center justify-between gap-2 rounded-base border border-line px-3 py-1.5">
          <span className={`text-sm ${t.active ? "text-text" : "text-muted line-through"}`}>{t.name}</span>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-muted">
              <Checkbox
                checked={t.active}
                onChange={async () => {
                  await saveCredentialTag({ id: t.id, kind: t.kind, name: t.name, active: !t.active });
                  router.refresh();
                }}
              />
              Offered
            </label>
            <IconButton
              icon={Trash2}
              label="Delete"
              tone="danger"
              onClick={async () => {
                const result = await deleteCredentialTag(t.id);
                if (!result.ok) alert(result.error);
                router.refresh();
              }}
            />
          </div>
        </div>
      ))}

      <div className="flex items-end gap-2 pt-1">
        <div className="flex-1 space-y-1.5">
          <Label htmlFor={`add-${kind}`} className="sr-only">
            Add to {title}
          </Label>
          <Input
            id={`add-${kind}`}
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            placeholder={placeholder}
          />
        </div>
        <Button
          size="sm"
          variant="secondary"
          disabled={pending || !adding.trim()}
          onClick={() =>
            startTransition(async () => {
              const result = await saveCredentialTag({ kind, name: adding });
              if (!result.ok) {
                alert(result.error);
                return;
              }
              setAdding("");
              router.refresh();
            })
          }
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
