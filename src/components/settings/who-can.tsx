"use client";

import { useState, useTransition } from "react";
import { Crown, Loader2, Search, ShieldOff, Users } from "lucide-react";
import { holdersOf, type permissionCatalogue } from "@/actions/permission";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type CatalogueRow = Awaited<ReturnType<typeof permissionCatalogue>>[number];
type Result = NonNullable<Awaited<ReturnType<typeof holdersOf>>>;

/**
 * Who can do this, and how each of them came by it.
 *
 * The reverse of every other screen here, and the question an audit actually asks. The role matrix
 * cannot answer it: it shows role defaults, so it is blind to personal grants, personal denials,
 * `adminDefault` and anything reaching somebody through a report. For a key with no default role —
 * `payroll.manage`, say — the matrix shows every column off, which reads as "nobody" while every
 * admin in fact holds it.
 *
 * Grouped by *how* rather than listed flat, because "three people hold this, one of them only
 * because she manages the person who does" is the shape of the answer somebody needs.
 */

const VIA_LABEL: Record<string, string> = {
  superAdmin: "Super admin",
  adminDefault: "Admin, by default",
  roleDefault: "Their role",
  roleOverride: "Their role, changed here",
  userGrant: "Granted to them personally",
  inherited: "Inherited from somebody they manage",
};

const VIA_ORDER = ["superAdmin", "adminDefault", "roleOverride", "roleDefault", "userGrant", "inherited"];

const TIER_TONE: Record<string, "red" | "amber" | "default"> = {
  critical: "red",
  sensitive: "amber",
  standard: "default",
};

export function WhoCan({ catalogue }: { catalogue: CatalogueRow[] }) {
  const [, startTransition] = useTransition();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false);

  const trimmed = query.trim().toLowerCase();
  const matches = trimmed
    ? catalogue
        .filter((c) => c.label.toLowerCase().includes(trimmed) || c.key.toLowerCase().includes(trimmed))
        .slice(0, 12)
    : [];

  function pick(key: string) {
    setSelected(key);
    setResult(null);
    setLoading(true);
    setQuery("");
    startTransition(async () => {
      const r = await holdersOf(key);
      setResult(r);
      setLoading(false);
    });
  }

  const grouped = result
    ? VIA_ORDER.map((via) => ({ via, people: result.holders.filter((h) => h.via === via) })).filter(
        (g) => g.people.length > 0,
      )
    : [];

  return (
    <div className="space-y-4">
      <div className="max-w-xl space-y-1.5">
        <label htmlFor="who-can-search" className="text-[13px] font-medium text-muted">
          Pick a permission
        </label>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
          <Input
            id="who-can-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Run payroll, approve an order, open the vault…"
            className="pl-8"
            autoComplete="off"
          />
        </div>
        {matches.length > 0 && (
          <div className="overflow-hidden rounded-md border border-line bg-surface shadow-sm">
            {matches.map((m) => (
              <button
                key={m.key}
                type="button"
                onClick={() => pick(m.key)}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-surface-sunken"
              >
                <span className="min-w-0">
                  <span className="font-medium text-text">{m.label}</span>
                  <span className="ml-2 font-mono text-xs text-subtle">{m.key}</span>
                </span>
                <span className="shrink-0 text-xs text-subtle">{m.group}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {loading && (
        <p className="flex items-center gap-2 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          Working out who holds it…
        </p>
      )}

      {!loading && !selected && (
        <Card className="px-6 py-10 text-center text-sm text-muted">
          <Users className="mx-auto mb-2 h-5 w-5 text-subtle" />
          Search for a permission to see everyone who holds it — including the people the roles screen cannot show
          you, because they hold it personally or through somebody they manage.
        </Card>
      )}

      {result && (
        <div className="space-y-4">
          <Card>
            <CardHeader className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-sm font-medium text-text">
                {result.permission.label}
                {result.permission.tier !== "standard" && (
                  <Badge tone={TIER_TONE[result.permission.tier] ?? "default"}>{result.permission.tier}</Badge>
                )}
              </span>
              <span className="text-sm text-muted">
                {result.holders.length} of {result.consideredUsers} active{" "}
                {result.consideredUsers === 1 ? "person" : "people"}
              </span>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted">{result.permission.description}</p>
            </CardContent>
          </Card>

          {grouped.map((g) => (
            <Card key={g.via}>
              <CardHeader className="flex items-center gap-2 text-sm font-medium text-text">
                {g.via === "superAdmin" && <Crown className="h-4 w-4 text-warning" />}
                {VIA_LABEL[g.via] ?? g.via}
                <span className="text-xs font-normal text-subtle">
                  {g.people.length} {g.people.length === 1 ? "person" : "people"}
                </span>
              </CardHeader>
              <CardContent className="divide-y divide-line">
                {g.people.map((h) => (
                  <div key={h.id} className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0 last:pb-0">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-sm font-medium text-text">{h.name}</span>
                        <Badge>{h.role}</Badge>
                        {h.expiresAt && (
                          <Badge tone="amber">until {new Date(h.expiresAt).toLocaleDateString("en-IN")}</Badge>
                        )}
                      </div>
                      <p className="text-xs text-subtle">{h.why}</p>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          ))}

          {result.holders.length === 0 && (
            <Card className="px-6 py-8 text-center text-sm text-muted">
              Nobody active holds this.
            </Card>
          )}

          {result.denied.length > 0 && (
            <Card>
              <CardHeader className="flex items-center gap-2 text-sm font-medium text-text">
                <ShieldOff className="h-4 w-4 text-danger" />
                Explicitly refused
                <span className="text-xs font-normal text-subtle">
                  {/* Different from never having had it: somebody decided this. */}
                  somebody took this away, rather than it never applying
                </span>
              </CardHeader>
              <CardContent className="divide-y divide-line">
                {result.denied.map((d) => (
                  <div key={d.id} className="py-2 first:pt-0 last:pb-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm font-medium text-text">{d.name}</span>
                      <Badge>{d.role}</Badge>
                    </div>
                    <p className="text-xs text-subtle">{d.why}</p>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
