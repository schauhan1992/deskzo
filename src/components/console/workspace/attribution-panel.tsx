import type { ReactNode } from "react";
import Link from "next/link";
import { CircleCheck } from "lucide-react";
import { consoleReviewAttribution } from "@/actions/platform/console-partners";
import { ActionButton } from "@/components/console/kit/action-button";
import { DefinitionList, Panel } from "@/components/console/kit/panel";
import { LabelPill, StatusPill } from "@/components/console/kit/status";
import { AttributionFlags } from "@/components/console/partners/flags";
import { partnerPath } from "@/components/console/partners/format";
import { ATTRIBUTION_SOURCE, PARTNER_KIND, PARTNER_STATUS } from "@/lib/console-shared/labels";
import type { Caps } from "@/lib/console-shared/roles";
import type { WorkspaceAttributionView } from "@/lib/partners/console-data";
import { consoleClock } from "@/lib/platform/console-clock";
import { ChangePartnerButton } from "./attribution-dialog";

/**
 * Workspace 360 › Overview › Partner (spec §4.4, §9.2): which partner this workspace belongs to now —
 * or "Direct — no partner" — how it came to (source), since when, whether it earns commission, any
 * flag from its signup (outside the partner's territories, other partners that claimed it, named),
 * and the five changes before this one with staff's reasons. Every staff member reads it; SELLERS
 * change the partner ("Change partner") and mark a flagged signup reviewed. A server component: its
 * days are on the console's clock.
 */

export async function AttributionPanel({ view, tenant, caps }: { view: WorkspaceAttributionView; tenant: { id: string; name: string }; caps: Caps }) {
  const clock = await consoleClock();
  const current = view.current;
  const partner = current?.partner ?? null;
  const flagged = !!current?.flags && (current.flags.outsideTerritory || current.flags.conflicts.length > 0);
  const unreviewed = flagged && !current?.reviewedAt;
  const canChange = caps.partnerMoney;

  const actions =
    canChange && (
      <>
        {unreviewed && current && (
          <ActionButton
            action={consoleReviewAttribution.bind(null, current.id)}
            label="Mark reviewed"
            icon={<CircleCheck aria-hidden="true" className="h-4 w-4" />}
            confirm={{ title: "Mark reviewed", body: `${tenant.name} stays with ${partner?.displayName ?? "no partner"}, and its flag leaves the review queue.`, confirmLabel: "Mark reviewed" }}
            success="Attribution marked reviewed."
          />
        )}
        <ChangePartnerButton
          tenant={{ id: tenant.id, name: tenant.name, country: view.tenantCountry }}
          current={partner && current ? { slug: partner.slug, displayName: partner.displayName, commissionable: current.commissionable } : null}
        />
      </>
    );

  const items: { term: string; value: ReactNode; wide?: boolean }[] = [];
  if (current) {
    items.push({ term: "How", value: <LabelPill map={ATTRIBUTION_SOURCE} value={current.source} /> });
    items.push({ term: "Since", value: `${clock.date(current.validFrom)} · ${current.createdByName}` });
    if (partner) items.push({ term: "Commission", value: current.commissionable ? "Earns commission" : <StatusPill tone="neutral">No commission</StatusPill> });
    if (flagged) {
      items.push({
        term: "Flags",
        value: (
          <span className="inline-flex flex-col items-start gap-1">
            <AttributionFlags flags={current.flags} reviewed={!!current.reviewedAt} />
            {current.reviewedAt && <span className="text-xs text-subtle">{`Reviewed ${clock.date(current.reviewedAt)}${current.reviewedByName ? ` by ${current.reviewedByName}` : ""}`}</span>}
          </span>
        ),
        wide: true,
      });
    }
    if (current.reason) items.push({ term: "Reason", value: `“${current.reason}”`, wide: true });
  }

  return (
    <Panel title="Partner" description="Which partner sold this workspace, and earns on what it pays. Changes apply from now on." actions={actions || undefined}>
      <div className="space-y-4">
        {partner ? (
          <div className="flex flex-wrap items-center gap-2">
            <Link href={partnerPath(partner.slug)} className="text-sm font-semibold text-text hover:text-brand">
              {partner.displayName}
            </Link>
            <LabelPill map={PARTNER_KIND} value={partner.kind} />
            <LabelPill map={PARTNER_STATUS} value={partner.status} />
          </div>
        ) : (
          <p className="text-sm font-semibold text-text">Direct — no partner</p>
        )}

        {items.length > 0 && <DefinitionList items={items} />}

        {view.history.length > 0 && (
          <div>
            <h3 className="mb-2 text-[13px] font-medium text-text">Before this</h3>
            <ol className="divide-y divide-line rounded-lg border border-line">
              {view.history.map((h) => (
                <li key={h.id} className="px-3 py-2 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex flex-wrap items-center gap-1.5">
                      {h.partner ? (
                        <Link href={partnerPath(h.partner.slug)} className="font-medium text-text hover:text-brand">
                          {h.partner.displayName}
                        </Link>
                      ) : (
                        <span className="font-medium text-text">Direct</span>
                      )}
                      <LabelPill map={ATTRIBUTION_SOURCE} value={h.source} />
                      {h.partner && !h.commissionable && <StatusPill tone="neutral">No commission</StatusPill>}
                    </span>
                    <span className="text-xs text-muted">{`${clock.date(h.validFrom)} – ${h.validTo ? clock.date(h.validTo) : "now"} · ${h.createdByName}`}</span>
                  </div>
                  {h.reason && <p className="mt-0.5 text-xs break-words text-muted">{`“${h.reason}”`}</p>}
                </li>
              ))}
            </ol>
          </div>
        )}

        {!current && view.history.length === 0 && <p className="text-xs text-muted">It signed up without a partner, and none has been assigned since.</p>}
      </div>
    </Panel>
  );
}
