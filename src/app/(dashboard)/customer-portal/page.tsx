import Link from "next/link";
import { Globe, ShieldOff, UserX } from "lucide-react";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { portalRoster } from "@/actions/portal";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { SearchParamInput } from "@/components/ui/search-param-input";
import { formatDateTime } from "@/lib/utils";

/**
 * Everyone who can open a portal.
 *
 * Under `/customer-portal` rather than `/portal`, which is a public prefix — see `PUBLIC_PREFIXES`
 * in src/proxy.ts and the note on the requests page.
 */
export const dynamic = "force-dynamic";

export default async function CustomerPortalPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const user = await requireUser();
  if (!(await can(user.id, "portal.manage"))) {
    return (
      <div className="max-w-md">
        <h1 className="text-xl font-semibold text-text">Portal access</h1>
        <p className="mt-2 text-sm text-muted">You don&rsquo;t have access to the customer portal.</p>
      </div>
    );
  }

  const roster = await portalRoster(q);
  if (!roster.ok) return <p className="text-sm text-danger">{roster.error}</p>;
  const { mode, enabled, rows, grantedWithoutLinks, eligibleWithoutLinks } = roster.data;

  const live = rows.filter((r) => r.allowed);
  const liveLinks = live.reduce((n, r) => n + r.activeLinks, 0);

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text">Portal access</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Every customer holding a link, who at each one holds it, and whether they have ever opened it.
          </p>
        </div>
        <Link href="/settings/portal" className="text-sm font-medium text-brand hover:underline">
          Portal settings
        </Link>
      </div>

      {!enabled && (
        <Card className="mt-4 border-warning/40 bg-warning-bg">
          <CardContent className="flex items-start gap-2 py-3 text-sm text-warning">
            <ShieldOff className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              <span className="font-medium">The portal is switched off.</span> None of the links below work, whoever
              holds them — which is the right state if you are not using it yet.
            </span>
          </CardContent>
        </Card>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <Card>
          <CardContent className="py-3">
            <div className="text-xs text-muted">Customers with a working link</div>
            <div className="mt-0.5 text-2xl font-semibold text-text">{live.length}</div>
            <div className="mt-0.5 text-xs text-muted">
              {liveLinks} link{liveLinks === 1 ? "" : "s"} between them
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3">
            <div className="text-xs text-muted">Have actually opened it</div>
            <div className="mt-0.5 text-2xl font-semibold text-text">
              {live.filter((r) => r.lastSeenAt).length}
              <span className="text-base font-normal text-muted">/{live.length}</span>
            </div>
            <div className="mt-0.5 text-xs text-muted">the rest were sent a link and never used it</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3">
            <div className="text-xs text-muted">Who may have one</div>
            <div className="mt-1.5">
              <Badge tone={mode === "ALL" ? "amber" : "default"}>
                {mode === "ALL" ? "Every customer" : "Only chosen customers"}
              </Badge>
            </div>
            {mode === "ALL" && eligibleWithoutLinks > 0 && (
              <div className="mt-1.5 text-xs text-muted">{eligibleWithoutLinks} more could be sent a link today</div>
            )}
          </CardContent>
        </Card>
      </div>

      {grantedWithoutLinks.length > 0 && (
        <Card className="mt-4 bg-surface-sunken">
          <CardContent className="flex items-start gap-2 py-3 text-sm">
            <UserX className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
            <div>
              <p className="font-medium text-text">
                {grantedWithoutLinks.length} customer{grantedWithoutLinks.length === 1 ? " was" : "s were"} switched on
                but never sent a link
              </p>
              {/* Invisible from the customer's own page, which simply says "allowed". */}
              <p className="mt-0.5 text-muted">
                {grantedWithoutLinks.slice(0, 8).map((c, i) => (
                  <span key={c.companyId}>
                    {i > 0 && " · "}
                    <Link href={`/companies/${c.companyId}?tab=portal`} className="text-brand hover:underline">
                      {c.companyName}
                    </Link>
                  </span>
                ))}
                {grantedWithoutLinks.length > 8 && ` · and ${grantedWithoutLinks.length - 8} more`}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="mt-5 max-w-sm">
        <SearchParamInput paramName="q" placeholder="Search customers…" />
      </div>

      <Card className="mt-3">
        <CardHeader className="flex items-center gap-2 text-sm font-medium text-text">
          <Globe className="h-4 w-4 text-muted" />
          Customers with links
        </CardHeader>
        <CardContent className="p-0">
          {rows.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-muted">
              {q
                ? "No customer matches that."
                : "No link has been issued yet. Open a customer and use the Portal tab."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-muted">
                    <th className="px-5 py-2 font-medium">Customer</th>
                    <th className="px-5 py-2 font-medium">Who holds a link</th>
                    <th className="px-5 py-2 font-medium">Access</th>
                    <th className="px-5 py-2 font-medium">Last opened</th>
                    <th className="px-5 py-2 font-medium">Opens</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr
                      key={r.companyId}
                      className="border-b border-line align-top last:border-0 hover:bg-surface-sunken"
                    >
                      <td className="px-5 py-2.5">
                        <Link
                          href={`/companies/${r.companyId}?tab=portal`}
                          className="font-medium text-brand hover:underline"
                        >
                          {r.companyName}
                        </Link>
                        {r.revokedLinks > 0 && (
                          <div className="text-xs text-subtle">
                            {r.revokedLinks} revoked link{r.revokedLinks === 1 ? "" : "s"}
                          </div>
                        )}
                      </td>
                      <td className="px-5 py-2.5 text-text">
                        {r.people.length === 0 ? (
                          <span className="text-muted">nobody — all revoked</span>
                        ) : (
                          r.people.join(", ")
                        )}
                      </td>
                      <td className="px-5 py-2.5">
                        {r.allowed ? (
                          <Badge tone={r.via === "granted" ? "green" : "default"}>
                            {r.via === "granted" ? "Granted" : "Via the default"}
                          </Badge>
                        ) : (
                          <div>
                            <Badge tone="red">Blocked</Badge>
                            <div className="mt-0.5 max-w-56 text-xs text-muted">{r.because}</div>
                          </div>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-5 py-2.5 text-muted">
                        {r.lastSeenAt ? formatDateTime(r.lastSeenAt) : "never"}
                      </td>
                      <td className="px-5 py-2.5 text-muted">{r.totalVisits || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
