import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { pendingVerifications, verificationSummary } from "@/actions/verification";
import { badEmailContacts, emailVerificationSummary } from "@/actions/email-verification";
import { Card } from "@/components/ui/card";
import { Pagination } from "@/components/ui/pagination";
import { TabNav } from "@/components/ui/tab-nav";
import { PAGE_SIZES, resolvePage, resolvePageSize, totalPages } from "@/lib/pagination";
import { VerificationRows } from "@/components/verifications/verification-rows";
import { BadEmailRows } from "@/components/verifications/bad-email-rows";

/**
 * Where the address book gets held to account.
 *
 * Two queues that answer the same question from opposite ends. "Reported on calls" is what people
 * found out by ringing: a claim from a human, which nothing acts on until somebody accepts it.
 * "Email health" is what the machine found in DNS, which is weaker evidence but costs nothing and
 * covers every row at once.
 */
export default async function VerificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; pageSize?: string; view?: string }>;
}) {
  const enabled = await isModuleEnabled("workspace");
  if (!enabled) return <ModuleDisabledNotice moduleKey="workspace" />;

  const params = await searchParams;
  const page = resolvePage(params.page);
  const pageSize = resolvePageSize(params.pageSize);
  const view = params.view === "emails" || params.view === "corrections" ? params.view : "reported";

  const [result, summary, emails, badEmails] = await Promise.all([
    pendingVerifications({ page, pageSize, onlyCorrections: view === "corrections" }),
    verificationSummary(),
    emailVerificationSummary(),
    view === "emails" ? badEmailContacts({ page, pageSize }) : Promise.resolve({ rows: [], total: 0 }),
  ]);

  const total = view === "emails" ? badEmails.total : result.total;

  return (
    <div className="animate-fade-rise">
      <div>
        <h1 className="text-xl font-semibold text-text">Contact checks</h1>
        <p className="mt-1 text-sm text-muted">
          Whether the details on file still reach anybody. Nothing here has changed a contact — both the old and the
          new value are kept until someone decides.
        </p>
      </div>

      <div className="mt-5">
        <TabNav
          basePath="/verifications"
          paramName="view"
          activeKey={view}
          tabs={[
            { key: "reported", label: `Reported on calls (${summary.pending})` },
            { key: "corrections", label: `With a correction (${summary.corrections})` },
            { key: "emails", label: `Email health (${emails.risky + emails.invalid})` },
          ]}
        />
      </div>

      {view === "emails" ? (
        <>
          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Addresses on file" value={emails.total} hint="contacts with an email" />
            <Stat label="Never checked" value={emails.unchecked} hint="nobody has looked" />
            <Stat label="Verified" value={emails.valid} hint="domain accepts mail" />
            <Stat label="Won't deliver" value={emails.invalid} hint="bounces, or a dead domain" />
          </div>

          <div className="mt-5">
            <BadEmailRows rows={badEmails.rows} />
          </div>
        </>
      ) : (
        <>
          <div className="mt-5 grid grid-cols-3 gap-3">
            <Stat label="Waiting" value={summary.pending} hint="reported by a caller" />
            <Stat label="With a correction" value={summary.corrections} hint="a new value to accept or reject" />
            <Stat label="Known bad" value={summary.wrong} hint="wrong, with nothing to replace them" />
          </div>

          <div className="mt-5">
            <VerificationRows rows={result.rows} />
          </div>
        </>
      )}

      <Pagination
        page={page}
        pageSize={pageSize}
        total={total}
        totalPages={totalPages(total, pageSize)}
        pageSizes={PAGE_SIZES}
      />
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <Card className="px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-subtle">{label}</div>
      <div className="mt-1 text-lg font-semibold text-text">{value.toLocaleString("en-IN")}</div>
      <div className="mt-0.5 text-xs text-muted">{hint}</div>
    </Card>
  );
}
