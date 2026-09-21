"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { MailCheck, Search, Trash2 } from "lucide-react";
import type { listAudiences, previewAudience } from "@/actions/marketing";
import { deleteAudience, previewAudience as runPreview } from "@/actions/marketing";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { describeContactFilters, parseContactFilters } from "@/lib/marketing/audience";
import { countActiveFilters, filterLabels, type WorkbookFilters } from "@/lib/workspace/filters";
import { AudienceEditor } from "@/components/marketing/audience-editor";
import type { workbookFilterOptions } from "@/actions/workspace";

type Audience = Awaited<ReturnType<typeof listAudiences>>[number];
type Preview = NonNullable<Awaited<ReturnType<typeof previewAudience>>>;
type Options = Awaited<ReturnType<typeof workbookFilterOptions>>;

/**
 * The dry run is the point of this screen.
 *
 * "847 will get this, 112 won't, and here are the reasons" is the difference between a campaign
 * somebody can sign off and one they have to hope about. Nobody should ever press send on a number
 * they have not seen broken down.
 */
export function AudienceList({
  audiences,
  canManage,
  options,
}: {
  audiences: Audience[];
  canManage: boolean;
  options: Options;
}) {
  if (audiences.length === 0) {
    return (
      <Card className="px-4 py-12 text-center">
        <MailCheck className="mx-auto mb-2 h-5 w-5 text-subtle" />
        <p className="text-sm text-subtle">
          No audiences yet. An audience is a saved set of filters — the same ones the calling workspace uses, plus
          rules about which contacts at each company to write to.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {audiences.map((a) => (
        <AudienceRow key={a.id} audience={a} canManage={canManage} options={options} />
      ))}
    </div>
  );
}

function AudienceRow({
  audience,
  canManage,
  options,
}: {
  audience: Audience;
  canManage: boolean;
  options: Options;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const companyFilters = (audience.companyFilters ?? {}) as WorkbookFilters;
  const active = countActiveFilters(companyFilters);
  const named = Object.entries(companyFilters)
    .filter(([, v]) => (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== false && v !== ""))
    .slice(0, 4)
    .map(([k]) => filterLabels[k as keyof WorkbookFilters] ?? k);

  return (
    <Card className="px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-text">{audience.name}</span>
            {audience._count.campaigns > 0 && <Badge tone="blue">{audience._count.campaigns} campaign(s)</Badge>}
            {audience._count.journeys > 0 && <Badge tone="blue">{audience._count.journeys} journey(s)</Badge>}
          </div>
          {audience.description && <p className="text-xs text-muted">{audience.description}</p>}
          <p className="text-[11px] text-subtle">
            {active === 0 ? "Every company we may contact" : `${active} filter(s): ${named.join(", ")}`}
            {" · "}
            {describeContactFilters(parseContactFilters(audience.contactFilters))}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={pending}
            onClick={() => {
              setError(null);
              startTransition(async () => {
                const result = await runPreview({
                  companyFilters: audience.companyFilters,
                  contactFilters: audience.contactFilters,
                });
                if (!result) {
                  setError("Couldn't work that out.");
                  return;
                }
                setPreview(result);
              });
            }}
          >
            <Search className="mr-1.5 h-3 w-3" />
            {pending ? "Counting…" : "Who'd get this?"}
          </Button>
          {canManage && <AudienceEditor audience={audience} options={options} />}
          {canManage && (
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => {
                setError(null);
                startTransition(async () => {
                  const result = await deleteAudience(audience.id);
                  if (!result.ok) setError(result.error);
                  router.refresh();
                });
              }}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          )}
        </div>
      </div>

      {error && <p className="mt-2 text-xs text-danger">{error}</p>}

      {preview && (
        <div className="mt-3 space-y-3 rounded-lg bg-surface-sunken px-3 py-3">
          <div className="flex flex-wrap items-baseline gap-4">
            <span className="text-sm text-text">
              <span className="text-lg font-semibold tabular-nums">{preview.sendable}</span> would receive it
            </span>
            <span className="text-sm text-muted">
              <span className="font-semibold tabular-nums">{preview.suppressed}</span> would not
            </span>
            <span className="text-xs text-subtle">
              across {preview.companies} compan{preview.companies === 1 ? "y" : "ies"}
            </span>
          </div>

          {preview.byReason.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-text">Why the rest wouldn&apos;t:</p>
              <ul className="space-y-0.5">
                {preview.byReason.map((r) => (
                  <li key={r.key} className="flex items-baseline justify-between gap-3 text-xs text-muted">
                    <span>{r.label}</span>
                    <span className="tabular-nums">{r.count}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {preview.sample.length > 0 && (
            <div>
              <p className="text-xs font-medium text-text">For example:</p>
              <p className="text-xs text-muted">
                {preview.sample.map((s) => `${s.name} at ${s.company}`).join(" · ")}
              </p>
            </div>
          )}

          {preview.sendable === 0 && (
            <p className="text-xs text-warning">
              Nobody at all. Either the filters are too narrow, or everybody who matches is suppressed — the reasons
              above say which.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
