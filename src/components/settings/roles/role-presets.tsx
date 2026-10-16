"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { applyPreset, previewPreset } from "@/actions/access";
import { Button } from "@/components/ui/button";
import { ActionNotice } from "@/components/ui/action-notice";

type Preset = { key: string; label: string; description: string };
type Preview = NonNullable<Awaited<ReturnType<typeof previewPreset>>>;

/**
 * The built-in starting points for a role (src/lib/authz/presets.ts): what applying one would grant
 * and take away, shown before it is applied — through `previewPreset` and `applyPreset`, with their
 * rules (nobody applies a preset holding more than they do; Admin's are the super admin's).
 */
export function RolePresets({ presets, mayManage, labels }: { presets: Preset[]; mayManage: boolean; labels: Record<string, string> }) {
  const router = useRouter();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [pending, start] = useTransition();
  if (presets.length === 0) return <p className="text-sm text-subtle">No built-in preset is written for this role.</p>;
  return (
    <div className="space-y-3">
      <ul className="space-y-2">
        {presets.map((p) => (
          <li key={p.key} className="flex flex-wrap items-start justify-between gap-3 rounded-base border border-line px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-sm font-medium text-text">{p.label}</p>
              <p className="text-xs text-muted">{p.description}</p>
            </div>
            {mayManage && (
              <Button
                variant="secondary"
                size="sm"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    setNotice(null);
                    const diff = await previewPreset(p.key);
                    if (!diff) setNotice({ tone: "error", text: "You can't apply presets." });
                    setPreview(diff);
                  })
                }
              >
                Preview
              </Button>
            )}
          </li>
        ))}
      </ul>
      {preview && (
        <div className="space-y-2 rounded-base border border-brand/30 bg-brand/5 p-3 text-sm">
          <p className="font-medium text-text">Applying “{preview.preset.label}”</p>
          <p className="text-muted">
            Grants {preview.willGrant.length}, takes away {preview.willRevoke.length}, leaves {preview.unchanged} as they are. Menu sections are left alone.
          </p>
          {preview.willGrant.length > 0 && <p className="text-xs text-success">+ {preview.willGrant.map((k) => labels[k] ?? k).join(", ")}</p>}
          {preview.willRevoke.length > 0 && <p className="text-xs text-danger">− {preview.willRevoke.map((k) => labels[k] ?? k).join(", ")}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setPreview(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const r = await applyPreset(preview.preset.key);
                  setPreview(null);
                  setNotice(r.ok ? { tone: "success", text: `Applied: ${r.data.granted} granted, ${r.data.revoked} taken away.` } : { tone: "error", text: r.error });
                  router.refresh();
                })
              }
            >
              Apply preset
            </Button>
          </div>
        </div>
      )}
      {notice && <ActionNotice tone={notice.tone}>{notice.text}</ActionNotice>}
    </div>
  );
}
