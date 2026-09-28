import type { ReactNode } from "react";
import { Banner } from "@/components/console/kit/banner";
import { DefinitionList, Panel } from "@/components/console/kit/panel";
import { StatusPill } from "@/components/console/kit/status";
import { DataTable, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { dayMonthYear, plural } from "@/lib/console-shared/format";
import type { Caps } from "@/lib/console-shared/roles";
import type { ConsoleTermsRow, PartnerTermsView } from "@/lib/partners/console-data";
import { bpToPercent, type PartnerKind, type TermsInput } from "@/lib/partners/types";
import { countryName } from "./format";
import { NewTermsButton } from "./new-terms-dialog";

/**
 * Partner 360 › Terms (spec §3.3, §9.2): the terms in force, any starting later, and the history —
 * rates are money, so SELLERS only. Anyone else reads one line saying so, and the loader has read no
 * rates at all for them. "New terms" (SELLERS) adds a version from a day on; terms are never edited or
 * backdated. Server-safe.
 */

export const TERMS_HIDDEN = "Commission terms are visible to billing staff.";

const muted = (text: string) => <span className="text-muted">{text}</span>;

function newText(t: ConsoleTermsRow): ReactNode {
  return t.newRateBp === null ? muted("Not set — the default applies") : `${bpToPercent(t.newRateBp)} for the first ${plural(t.newMonths, "month")}`;
}

function TermsDetail({ terms, kind }: { terms: ConsoleTermsRow; kind: PartnerKind }) {
  const items: { term: string; value: ReactNode; wide?: boolean }[] = [
    { term: "Default rate", value: bpToPercent(terms.defaultRateBp) },
    { term: "New customers", value: newText(terms) },
    { term: "Renewals", value: terms.renewalRateBp === null ? muted("Not set — the default applies") : bpToPercent(terms.renewalRateBp) },
    { term: "Lasts", value: terms.durationMonths === null ? "The customer's lifetime" : `${plural(terms.durationMonths, "month")} from the first paid invoice` },
  ];
  if (kind === "DISTRIBUTOR") {
    items.push({ term: "Override on its resellers' customers", value: terms.overrideRateBp === null ? muted("None") : bpToPercent(terms.overrideRateBp) });
    items.push({ term: "Territory default", value: terms.territoryRateBp === null ? muted("Off") : bpToPercent(terms.territoryRateBp) });
  }
  items.push({
    term: "Plan rates",
    value: terms.planRates.length ? terms.planRates.map((r) => `${r.planName ?? r.planKey} ${bpToPercent(r.rateBp)}`).join(" · ") : muted("None"),
    wide: true,
  });
  items.push({
    term: "Country rates",
    value: terms.countryRates.length ? terms.countryRates.map((r) => `${r.countryName ?? countryName(r.country)} ${bpToPercent(r.rateBp)}`).join(" · ") : muted("None"),
    wide: true,
  });
  if (terms.note) items.push({ term: "Note", value: terms.note, wide: true });
  items.push({ term: "Set", value: `${dayMonthYear(terms.createdAt)} by ${terms.createdByName}` });
  return <DefinitionList items={items} />;
}

export function PartnerTermsTab({
  view,
  caps,
  partner,
  defaults,
  plans,
  todayKey,
}: {
  view: PartnerTermsView | null;
  caps: Caps;
  partner: { id: string; displayName: string; kind: PartnerKind; terminated: boolean };
  defaults: TermsInput;
  plans: { key: string; name: string }[];
  todayKey: string;
}) {
  if (!caps.partnerMoney || !view) {
    return (
      <Panel>
        <p className="text-sm text-muted">{TERMS_HIDDEN}</p>
      </Panel>
    );
  }

  const action = partner.terminated ? undefined : <NewTermsButton partner={partner} defaults={defaults} plans={view.plans.length ? view.plans : plans} todayKey={todayKey} />;

  return (
    <div className="space-y-6">
      {!view.inForce && (
        <Banner tone="warning" title="No terms in force" action={action}>
          {view.scheduled.length ? `It earns nothing until ${dayMonthYear(view.scheduled[0]!.effectiveFrom)}, when its next terms start.` : "It earns nothing on its customers' invoices until terms are set."}
        </Banner>
      )}

      {view.inForce && (
        <Panel title="In force" description={`Since ${dayMonthYear(view.inForce.effectiveFrom)}.`} actions={action}>
          <TermsDetail terms={view.inForce} kind={view.kind} />
        </Panel>
      )}

      {view.scheduled.map((t) => (
        <Panel key={t.id} title={<span className="inline-flex items-center gap-2">Starts {dayMonthYear(t.effectiveFrom)} <StatusPill tone="info">Scheduled</StatusPill></span>}>
          <TermsDetail terms={t} kind={view.kind} />
        </Panel>
      ))}

      <Panel title="History" description="Earlier terms, the latest first. Each invoice earned under the terms in force when it was paid." padded={view.past.length === 0}>
        {view.past.length === 0 ? (
          <p className="text-sm text-muted">No earlier terms.</p>
        ) : (
          <DataTable caption="Earlier terms" minWidth={820}>
            <THead>
              <Th>From</Th>
              <Th numeric>Default</Th>
              <Th numeric>New customers</Th>
              <Th numeric>Renewals</Th>
              <Th>Lasts</Th>
              {view.kind === "DISTRIBUTOR" && <Th numeric>Override</Th>}
              <Th>Set by</Th>
            </THead>
            <TBody>
              {view.past.map((t) => (
                <Tr key={t.id}>
                  <Td nowrap>{dayMonthYear(t.effectiveFrom)}</Td>
                  <Td numeric>{bpToPercent(t.defaultRateBp)}</Td>
                  <Td numeric>{t.newRateBp === null ? "—" : `${bpToPercent(t.newRateBp)} · ${t.newMonths} mo`}</Td>
                  <Td numeric>{t.renewalRateBp === null ? "—" : bpToPercent(t.renewalRateBp)}</Td>
                  <Td muted>{t.durationMonths === null ? "Lifetime" : plural(t.durationMonths, "month")}</Td>
                  {view.kind === "DISTRIBUTOR" && <Td numeric>{t.overrideRateBp === null ? "—" : bpToPercent(t.overrideRateBp)}</Td>}
                  <Td muted nowrap>
                    {`${dayMonthYear(t.createdAt)} · ${t.createdByName}`}
                  </Td>
                </Tr>
              ))}
            </TBody>
          </DataTable>
        )}
      </Panel>
    </div>
  );
}
