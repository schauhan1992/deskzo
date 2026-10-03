import Link from "next/link";
import { Badge, Card } from "@/components/ui/card";
import { workspaceClock } from "@/lib/time/workspace";
import { CallButton } from "@/components/calls/call-button";
import type { runWorkbook } from "@/actions/workspace";
import type { WorkbookFilters } from "@/lib/workspace/filters";
import { headcountLabel } from "@/lib/company-size";
import { companyPath } from "@/lib/record-links";

type Row = Awaited<ReturnType<typeof runWorkbook>>["rows"][number];

/**
 * The list itself.
 *
 * Columns are the ones that decide what to do with a row rather than everything known about it —
 * who owns it, where it is, how big, and when it was last called. Each row carries a call button,
 * because the point of a worklist is to be worked from, not read.
 */
export async function WorkbookResults({ rows, filters }: { rows: Row[]; filters?: WorkbookFilters }) {
  const clock = await workspaceClock();
  // When the list was narrowed by place, the row shows the site that actually matched rather than
  // the head office — otherwise a correct match reads as a bug.
  const wantedCities = (filters?.city ?? []).map((c) => c.toLowerCase());
  const wantedStates = (filters?.state ?? []).map((s) => s.toLowerCase());
  const matchingSite = (row: Row) =>
    row.locations.find(
      (l) =>
        (wantedCities.length > 0 && l.city && wantedCities.includes(l.city.toLowerCase())) ||
        (wantedStates.length > 0 && l.state && wantedStates.includes(l.state.toLowerCase())),
    ) ?? row.locations[0];

  return (
    <Card className="overflow-x-auto p-0">
      <table className="w-full text-sm">
        <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
          <tr>
            <th className="px-4 py-2.5">Company</th>
            <th className="px-4 py-2.5">Where</th>
            <th className="px-4 py-2.5">Stage</th>
            <th className="px-4 py-2.5 text-right">Staff</th>
            <th className="px-4 py-2.5">Owner</th>
            <th className="px-4 py-2.5">Last call</th>
            <th className="px-4 py-2.5" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const site = matchingSite(row);
            const lastCall = row.calls[0];
            return (
              <tr key={row.id} className="border-b border-line last:border-0 hover:bg-surface-sunken">
                <td className="px-4 py-2.5">
                  <Link href={companyPath(row.companySeq)} className="font-medium text-text hover:underline">
                    {row.name}
                  </Link>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-subtle">
                    {row.industry?.name && <span>{row.industry.name}</span>}
                    {row._count.products > 0 && <span>{row._count.products} order(s)</span>}
                    {row._count.contacts > 0 && <span>{row._count.contacts} contact(s)</span>}
                    {row.domainProfile?.emailProvider && <span>{row.domainProfile.emailProvider}</span>}
                  </div>
                </td>
                <td className="px-4 py-2.5 text-muted">
                  {site ? [site.city, site.state].filter(Boolean).join(", ") || "—" : "—"}
                  {row._count.locations > 1 && (
                    <div className="text-xs text-subtle">
                      {row._count.locations} sites{site && !site.isPrimary ? " · this one matched" : ""}
                    </div>
                  )}
                </td>
                <td className="px-4 py-2.5">
                  <Badge tone={row.stage === "CUSTOMER" ? "green" : row.stage === "LEAD" ? "blue" : "default"}>
                    {row.stage}
                  </Badge>
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-muted">{headcountLabel(row.employeeCount) ?? "—"}</td>
                <td className="px-4 py-2.5 text-muted">{row.owner?.name ?? "Unassigned"}</td>
                <td className="px-4 py-2.5 text-xs text-subtle">
                  {lastCall ? (
                    <>
                      {clock.date(lastCall.startedAt)}
                      <div className="text-subtle">{lastCall.outcome.replaceAll("_", " ").toLowerCase()}</div>
                    </>
                  ) : (
                    "Never"
                  )}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <CallButton companyId={row.id} companyName={row.name} size="sm" variant="ghost" />
                </td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr>
              <td colSpan={7} className="px-4 py-12 text-center text-subtle">
                Nothing matches these filters. Loosen one and the count above will tell you before you save.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Card>
  );
}
