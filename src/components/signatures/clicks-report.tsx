import Link from "next/link";
import { Badge, Card } from "@/components/ui/card";
import { ClickTrackingSwitch } from "@/components/signatures/click-tracking-switch";
import { CLICK_PERIODS, type ClickDetail, type ClickItem } from "@/lib/signatures/clicks";
import { cn } from "@/lib/utils";

/** A typed day (YYYY-MM-DD) as people read it — the day itself, whatever the zone. */
function day(value: string, withYear = false): string {
  return new Date(`${value}T00:00:00Z`).toLocaleDateString("en-GB", { timeZone: "UTC", day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}) });
}

const href = (days: number, item?: string) => `/signatures/manage?tab=clicks&days=${days}${item ? `&item=${encodeURIComponent(item)}` : ""}`;

function Bars({ rows }: { rows: { label: string; clicks: number }[] }) {
  const most = Math.max(1, ...rows.map((r) => r.clicks));
  return (
    <ul className="space-y-1.5">
      {rows.map((r) => (
        <li key={r.label} className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)_3rem] items-center gap-3 text-sm">
          <span className="truncate text-text">{r.label}</span>
          <span className="h-2 rounded-full bg-surface-sunken">
            <span className="block h-2 rounded-full bg-brand" style={{ width: `${(r.clicks / most) * 100}%` }} />
          </span>
          <span className="text-right tabular-nums text-muted">{r.clicks}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Clicks on the company's signature banners and buttons — src/lib/signatures/clicks.ts. Who clicked is
 * never known: the counts are per banner or button, per person whose signature carried it, per day.
 */
export function ClicksReport({
  counting,
  days,
  items,
  selected,
}: {
  counting: boolean;
  days: number;
  items: ClickItem[];
  selected: { item: ClickItem; detail: ClickDetail } | null;
}) {
  const most = selected ? Math.max(1, ...selected.detail.byDay.map((d) => d.clicks)) : 1;
  return (
    <div className="space-y-5">
      <Card className="space-y-2 p-5">
        <ClickTrackingSwitch on={counting} />
        <p className="text-sm text-muted">
          While on, a banner&apos;s link and a button&apos;s link in each signature go through your workspace&apos;s own short address, which counts the click and sends the
          reader straight on. The logo, website and social profiles link directly — those are the addresses readers check before trusting an email. Who clicked is never
          known or kept.
        </p>
        <p className="text-xs text-subtle">
          Mail programs that check links before the reader sees them are left out where they can be told apart, and the same link from the same place counts once in ten
          minutes. Some checkers can&apos;t be told apart, so treat the numbers as a little high.
        </p>
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted">Last</span>
        {CLICK_PERIODS.map((p) => (
          <Link
            key={p}
            href={href(p, selected?.item.key)}
            className={cn("rounded-base border px-3 py-1 text-sm", p === days ? "border-brand bg-brand-subtle text-text" : "border-line text-muted hover:border-line-strong")}
          >
            {p} days
          </Link>
        ))}
      </div>

      {items.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted">No clicks yet. They show here once somebody clicks a banner or a button in a signature.</Card>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full min-w-[32rem] text-sm">
            <thead className="border-b border-line text-left text-xs text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Banner or button</th>
                <th className="px-3 py-2 text-right font-medium">Last {days} days</th>
                <th className="px-3 py-2 text-right font-medium">Ever</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {items.map((i) => (
                <tr key={i.key} className={selected?.item.key === i.key ? "bg-brand-subtle" : undefined}>
                  <td className="px-3 py-2">
                    <Link href={href(days, i.key)} className="font-medium text-text hover:underline">
                      {i.label}
                    </Link>{" "}
                    {i.note && <Badge tone={i.note === "Removed" ? "default" : i.kind === "BANNER" ? "brand" : "green"}>{i.note}</Badge>}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{i.clicks}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted">{i.allTime}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <div className="space-y-4">
          <h2 className="text-base font-semibold text-text">
            {selected.item.label} — {selected.detail.total} {selected.detail.total === 1 ? "click" : "clicks"} in {days} days
          </h2>
          <Card className="p-5">
            <h3 className="mb-3 text-sm font-semibold text-text">By day</h3>
            <div className="flex h-32 items-end gap-px" role="img" aria-label={`Clicks by day over the last ${days} days`}>
              {selected.detail.byDay.map((d) => (
                <span key={d.day} title={`${day(d.day, true)}: ${d.clicks}`} className="flex-1 rounded-t bg-brand/80" style={{ height: `${Math.max(d.clicks ? 4 : 1, (d.clicks / most) * 100)}%`, opacity: d.clicks ? 1 : 0.25 }} />
              ))}
            </div>
            <div className="mt-1 flex justify-between text-xs text-subtle">
              <span>{day(selected.detail.byDay[0]!.day)}</span>
              <span>{day(selected.detail.byDay[selected.detail.byDay.length - 1]!.day)}</span>
            </div>
          </Card>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card className="p-5">
              <h3 className="mb-3 text-sm font-semibold text-text">By team</h3>
              {selected.detail.byTeam.length ? <Bars rows={selected.detail.byTeam.map((t) => ({ label: t.team, clicks: t.clicks }))} /> : <p className="text-sm text-muted">None in this period.</p>}
            </Card>
            <Card className="p-5">
              <h3 className="mb-1 text-sm font-semibold text-text">Whose signature it was</h3>
              <p className="mb-3 text-xs text-subtle">The people whose emails were clicked — not who clicked.</p>
              {selected.detail.byPerson.length ? (
                <Bars rows={selected.detail.byPerson.slice(0, 20).map((p) => ({ label: p.name, clicks: p.clicks }))} />
              ) : (
                <p className="text-sm text-muted">None in this period.</p>
              )}
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
