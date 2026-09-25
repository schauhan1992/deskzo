import Link from "next/link";
import type { companyFormResponses } from "@/actions/forms";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { categoryOf } from "@/lib/forms/categories";
import { formatIstDateTime } from "@/lib/india-time";

type Data = NonNullable<Awaited<ReturnType<typeof companyFormResponses>>>;

/**
 * A customer's forms, on their company page: what they answered — the requirement assessment before
 * a proposal, the roundtable they came to — and the invitations still waiting on them.
 *
 * Only forms whose answers are shared with the viewer. The account being theirs is not enough; see
 * `companyFormResponses`.
 */
export function CompanyForms({ data }: { data: Data }) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="text-sm font-medium text-text">Answers</CardHeader>
        <CardContent className="p-0">
          {data.responses.length === 0 ? (
            <p className="px-5 py-6 text-center text-sm text-subtle">Nothing answered on a form you can read.</p>
          ) : (
            <ul className="divide-y divide-line">
              {data.responses.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5">
                  <div className="min-w-0">
                    <Link href={`/marketing/forms/${r.form.id}?tab=responses`} className="text-sm font-medium text-text hover:underline">
                      {r.form.name}
                    </Link>
                    <div className="text-xs text-muted">
                      {categoryOf(r.form.category).label} · {r.name ?? "—"} · {formatIstDateTime(r.createdAt)}
                    </div>
                  </div>
                  {r.form.category === "EVENT" && (
                    <span className="flex gap-1.5">
                      {r.attending === false ? <Badge tone="amber">Can&apos;t make it</Badge> : <Badge tone="green">Coming</Badge>}
                      {r.attendance === "ATTENDED" && <Badge tone="green">Came</Badge>}
                      {r.attendance === "NO_SHOW" && <Badge tone="red">No-show</Badge>}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {data.waiting.length > 0 && (
        <Card>
          <CardHeader className="text-sm font-medium text-text">Invited, not answered yet</CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y divide-line">
              {data.waiting.map((w) => (
                <li key={w.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5">
                  <div className="min-w-0">
                    <Link href={`/marketing/forms/${w.form.id}?tab=invites`} className="text-sm font-medium text-text hover:underline">
                      {w.form.name}
                    </Link>
                    <div className="text-xs text-muted">
                      {w.contact.name}
                      {w.lastSentAt && ` · sent ${formatIstDateTime(w.lastSentAt)}`}
                    </div>
                  </div>
                  <Badge>{categoryOf(w.form.category).label}</Badge>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
