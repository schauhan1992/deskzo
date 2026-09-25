import Link from "next/link";
import type { getSupportLoad } from "@/actions/support-load";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { HEAVY_MULTIPLE, LEVEL_LABELS, LEVEL_TONE, LIGHT_MULTIPLE, multipleText, type SupportLevel } from "@/lib/support/load";
import { formatCurrency } from "@/lib/utils";

type Load = NonNullable<Awaited<ReturnType<typeof getSupportLoad>>>;

export function SupportLevelBadge({ level, multiple }: { level: SupportLevel; multiple: number | null }) {
  return (
    <Badge tone={LEVEL_TONE[level]} title={multiple !== null ? `${multipleText(multiple)} the typical customer's tickets per ₹1 lakh billed` : undefined}>
      {LEVEL_LABELS[level]}
      {multiple !== null && (level === "HEAVY" || level === "LIGHT") && <span className="ml-1 opacity-80">· {multipleText(multiple)}</span>}
    </Badge>
  );
}

/** "12 h 30 m" — recorded time reads better as hours and minutes than as a decimal. */
function hoursAndMinutes(hours: number): string {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return h ? `${h} h${m ? ` ${m} m` : ""}` : `${m} m`;
}

/** 1st, 2nd, 3rd, 4th … 11th, 12th, 13th, 21st. */
function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${suffix}`;
}

const MONTH = new Intl.DateTimeFormat("en-IN", { month: "short", timeZone: "UTC" });

/**
 * A customer's support over the last year, set against what they were billed — the top of the
 * Tickets tab.
 *
 * The verdict first (heavy or light, and by how much against the typical customer), then what it is
 * made of, then where it comes from: which months, which products, who handled it. A number on its
 * own is not a judgement; this is laid out so that the number and the reason sit together.
 */
export function SupportLoadPanel({ load, ticketsHref }: { load: Load; ticketsHref?: string }) {
  const peak = Math.max(1, ...load.byMonth.map((m) => m.tickets));
  const verdict =
    load.level === "NONE"
      ? `No tickets, support calls or support visits in the last ${load.months} months.`
      : load.level === "UNBILLED"
        ? `Took support in the last ${load.months} months with nothing billed in the same months.`
        : load.multiple !== null
          ? `${multipleText(load.multiple)} the typical customer's tickets per ₹1 lakh billed (${load.ticketsPerLakh} against ${
              Math.round((load.typicalTicketsPerLakh ?? 0) * 100) / 100
            }). Heavy is ${HEAVY_MULTIPLE}× or more; light is ${LIGHT_MULTIPLE}× or less.`
          : load.billed === null
            ? "Compared with other customers on tickets per rupee billed — the billed figures need the payments view."
            : "Not enough other customers with both tickets and billing yet to say what is typical.";

  const tiles: [string, string, string?][] = [
    ["Tickets", String(load.tickets), load.urgent + load.high ? `${load.urgent} urgent · ${load.high} high` : undefined],
    ["Open now", String(load.open), load.openPastDue ? `${load.openPastDue} past their deadline` : undefined],
    ["Median time to resolve", load.medianResolutionHours === null ? "—" : load.medianResolutionHours >= 48 ? `${Math.round(load.medianResolutionHours / 24)} days` : `${Math.round(load.medianResolutionHours)} h`],
    ["Missed service deadline", String(load.pastDeadline), load.tickets ? `of ${load.tickets} tickets` : undefined],
    ["Replies on tickets", String(load.replies)],
  ];
  if (load.calls !== null && load.talkMinutes !== null) tiles.push(["Support calls", String(load.calls), load.talkMinutes ? `${hoursAndMinutes(load.talkMinutes / 60)} talking` : undefined]);
  if (load.visits !== null && load.onSiteHours !== null)
    tiles.push([
      "Support visits",
      String(load.visits),
      [load.onSiteHours ? `${hoursAndMinutes(load.onSiteHours)} on site` : "", load.distanceKm ? `${load.distanceKm} km` : "", load.visitExpenses ? formatCurrency(load.visitExpenses) : ""]
        .filter(Boolean)
        .join(" · ") || undefined,
    ]);
  if (load.billed !== null) tiles.push(["Billed, same months", formatCurrency(load.billed), load.ticketsPerLakh !== null ? `${load.ticketsPerLakh} tickets per ₹1 lakh` : undefined]);

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium text-text">
        <span className="flex items-center gap-2">
          Support in the last {load.months} months <SupportLevelBadge level={load.level} multiple={load.multiple} />
        </span>
        {load.rank !== null && (
          <span className="text-xs font-normal text-muted">
            {load.rank === 1 ? "Most tickets" : `${ordinal(load.rank)} most tickets`} of {load.rankedOf} customers
          </span>
        )}
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p className="text-muted">{verdict}</p>

        <div className="grid grid-cols-2 gap-3 @xl:grid-cols-4">
          {tiles.map(([label, value, hint]) => (
            <div key={label} className="rounded-md border border-line p-3">
              <div className="text-xs uppercase tracking-wide text-subtle">{label}</div>
              <div className="mt-1 text-base font-semibold text-text">{value}</div>
              {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
            </div>
          ))}
        </div>

        <div>
          <p className="mb-1.5 text-xs text-muted">Tickets by month</p>
          <div className="flex h-20 items-end gap-1" role="img" aria-label={load.byMonth.map((m) => `${m.month}: ${m.tickets}`).join(", ")}>
            {load.byMonth.map((m) => (
              <div key={m.month} className="flex flex-1 flex-col items-center gap-1" title={`${m.month}: ${m.tickets} ticket(s)`}>
                <div className="w-full rounded-sm bg-brand/70" style={{ height: `${(m.tickets / peak) * 56}px`, minHeight: m.tickets ? 3 : 0 }} />
                <span className="text-[10px] text-subtle">{MONTH.format(new Date(`${m.month}-01T00:00:00Z`)).slice(0, 1)}</span>
              </div>
            ))}
          </div>
        </div>

        {(load.topProducts.length > 0 || load.topHandlers.length > 0) && (
          <div className="grid gap-3 text-xs @xl:grid-cols-2">
            {load.topProducts.length > 0 && (
              <div>
                <p className="mb-1 text-muted">Most tickets are about</p>
                <ul className="space-y-0.5 text-text">
                  {load.topProducts.map((p) => (
                    <li key={p.name}>
                      {p.name} <span className="text-subtle">· {p.count}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {load.topHandlers.length > 0 && (
              <div>
                <p className="mb-1 text-muted">Handled mostly by</p>
                <ul className="space-y-0.5 text-text">
                  {load.topHandlers.map((h) => (
                    <li key={h.name}>
                      {h.name} <span className="text-subtle">· {h.count}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        <p className="text-xs text-subtle">
          Counts tickets (not demos), calls about a ticket or from the customer, and support or installation visits. Hours are only
          what was recorded — talk time and time on site; tickets carry no time log.
          {ticketsHref && (
            <>
              {" "}
              <Link href={ticketsHref} className="underline underline-offset-2">
                See the tickets
              </Link>
              .
            </>
          )}
        </p>
      </CardContent>
    </Card>
  );
}
