import type { Metadata } from "next";
import { ShieldCheck } from "lucide-react";
import type { PrivacyRequestStatus } from "@deskzo/control-client";
import { PrivacyRequestControls } from "@/components/console/privacy/privacy-request-controls";
import { EmptyState } from "@/components/console/kit/empty-state";
import { SelectFilter } from "@/components/console/kit/filter-controls";
import { FilterBar } from "@/components/console/kit/filters";
import { PageHeader } from "@/components/console/kit/page-header";
import { Panel } from "@/components/console/kit/panel";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { StatusPill } from "@/components/console/kit/status";
import { PRIVACY_STATUSES, privacyKindLabel, privacyRelationLabel } from "@/components/site/privacy-fields";
import { plural } from "@/lib/console-shared/format";
import { PAGE_ROLES } from "@/lib/console-shared/nav";
import type { RawParams } from "@/lib/console-shared/params";
import type { Tone } from "@/lib/console-shared/types";
import { consoleStaff } from "@/lib/platform/console-page";
import { listPrivacyRequests } from "@/lib/platform/privacy-requests";

export const metadata: Metadata = { title: "Privacy requests" };

const TONE: Record<PrivacyRequestStatus, Tone> = { NEW: "info", IN_PROGRESS: "warning", DONE: "success", REFUSED: "neutral" };
const statusLabel = (status: PrivacyRequestStatus) => PRIVACY_STATUSES.find((s) => s.value === status)?.label ?? status;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

/**
 * Privacy requests (owner, 23 Oct 2026): what deskzo.com/privacy/request sends — a copy of one's data, a
 * correction, erasure, withdrawn consent, a nominee, a grievance (src/lib/platform/privacy-requests.ts).
 * Owners, admins and support, who answer customers: the people's details are in full. Open ones first, the
 * soonest due first — each is due 30 days after it came in, as the privacy notice promises.
 */
export default async function ConsolePrivacyRequestsPage({ searchParams }: PageProps<"/platform-console/privacy-requests">) {
  await consoleStaff(PAGE_ROLES.privacy);
  const sp: RawParams = (await searchParams) ?? {};
  const status = one(sp.status);
  // Null until the release's control migration has made the table.
  const rows = await listPrivacyRequests({ status }).catch(() => null);
  const open = rows?.filter((r) => r.status === "NEW" || r.status === "IN_PROGRESS").length ?? 0;
  const overdue = rows?.filter((r) => r.overdue).length ?? 0;

  return (
    <>
      <PageHeader
        title="Privacy requests"
        subtitle={
          rows
            ? `${plural(open, "open request")}${overdue ? `, ${overdue} past due` : ""} — from the privacy request form on the website. Answer each within 30 days.`
            : "From the privacy request form on the website."
        }
      />
      <FilterBar>
        <SelectFilter
          param="status"
          label="Status"
          allLabel="Everything"
          options={[{ value: "open", label: "Open" }, ...PRIVACY_STATUSES.map((s) => ({ value: s.value, label: s.label }))]}
        />
      </FilterBar>

      {rows === null ? (
        <Panel>
          <EmptyState title="Not ready yet" body="This release's control-plane migration hasn't run here. Run npm run control:migrate, then reload." />
        </Panel>
      ) : rows.length === 0 ? (
        <Panel>
          <EmptyState
            icon={<ShieldCheck className="h-5 w-5" />}
            variant={status ? "filtered" : "empty"}
            clearHref="/privacy-requests"
            title={status ? "No requests match" : "No privacy requests yet"}
            body={status ? undefined : "When someone uses the form at /privacy/request, it lands here, and they get an email with its reference."}
          />
        </Panel>
      ) : (
        <ul aria-label="Privacy requests" className="space-y-4">
          {rows.map((r) => (
            <li key={r.id}>
              <Panel padded={false}>
                <div className="grid gap-5 p-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-mono text-xs text-muted">{r.ref}</p>
                      <StatusPill tone={TONE[r.status]}>{statusLabel(r.status)}</StatusPill>
                      {r.overdue && <StatusPill tone="danger">Past due</StatusPill>}
                    </div>
                    <h2 className="mt-2 text-sm font-semibold text-text">{privacyKindLabel(r.kind)}</h2>
                    <p className="mt-1 text-sm text-text">
                      {r.name} · <a href={`mailto:${r.email}?subject=${encodeURIComponent(`Your privacy request ${r.ref}`)}`} className="text-brand hover:underline">{r.email}</a>
                    </p>
                    <p className="mt-0.5 text-xs text-muted">
                      {privacyRelationLabel(r.relation)}
                      {r.company ? ` · ${r.company}` : ""}
                    </p>
                    <p className="mt-3 text-sm leading-6 break-words whitespace-pre-wrap text-text">{r.message}</p>
                    <p className="mt-3 text-xs text-subtle">
                      Came in <RelativeTime at={r.createdAt} /> ·{" "}
                      {r.closedAt ? (
                        <>
                          closed <RelativeTime at={r.closedAt} />
                        </>
                      ) : (
                        <span className={r.overdue ? "font-medium text-danger" : undefined}>
                          due <RelativeTime at={r.dueAt} absolute="date" />
                        </span>
                      )}
                    </p>
                  </div>
                  <div className="border-t border-line pt-4 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-5">
                    <PrivacyRequestControls key={`${r.status}:${r.notes ?? ""}`} id={r.id} status={r.status} notes={r.notes} />
                  </div>
                </div>
              </Panel>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
