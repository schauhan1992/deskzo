import Link from "next/link";
import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { hrCapabilities } from "@/actions/hr";
import { recentLetters } from "@/actions/employee-docs";
import { letterSignatureForHr, listLetterTemplates } from "@/actions/letter-templates";
import { LetterTemplatesManager } from "@/components/hr/letter-templates-manager";
import { LetterSignaturePanel } from "@/components/hr/letter-signature-panel";
import { TabNav } from "@/components/ui/tab-nav";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { Pagination } from "@/components/ui/pagination";
import { Badge, Card } from "@/components/ui/card";
import { totalPages } from "@/lib/pagination";
import { formatCalendarDay } from "@/lib/time/zone";
import { letterTypeLabels } from "@/lib/hr/letters";
import { personPath } from "@/lib/record-links";

type View = "letters" | "templates" | "signature";

/**
 * People › Letters (owner, 21 Oct 2026): every letter HR has drafted or issued, HR's own templates for
 * official documents, and the signature letters carry. HR's — `hr.manage` — as drafting letters is.
 */
export default async function LettersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const enabled = await isModuleEnabled("hr");
  if (!enabled) return <ModuleDisabledNotice moduleKey="hr" />;
  const caps = await hrCapabilities();
  if (!caps.manage) notFound();

  const query = await searchParams;
  const one = (key: string) => (typeof query[key] === "string" ? (query[key] as string) : undefined);
  const view: View = one("view") === "templates" ? "templates" : one("view") === "signature" ? "signature" : "letters";

  const [templates, signature, letters] = await Promise.all([
    listLetterTemplates(),
    view === "signature" ? letterSignatureForHr() : Promise.resolve(null),
    view === "letters" ? recentLetters({ status: one("status"), templateId: one("template"), page: Number(one("page")) || 1 }) : Promise.resolve(null),
  ]);

  return (
    <div className="animate-fade-rise">
      <h1 className="text-xl font-semibold text-text">Letters</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted">
        Letters are drafted from a person&apos;s page — the built-in ones, or your own templates from here. A draft can be reworded and signed or not
        before it&apos;s issued; once issued, it&apos;s fixed.
      </p>

      <div className="mt-5">
        <TabNav
          basePath="/people/letters"
          paramName="view"
          activeKey={view}
          otherParams={{}}
          tabs={[
            { key: "letters", label: "All letters" },
            { key: "templates", label: `Our templates${templates.length ? ` (${templates.length})` : ""}` },
            { key: "signature", label: "Signature" },
          ]}
        />
      </div>

      {view === "letters" && letters && (
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <SelectParamFilter
              paramName="status"
              label="Status"
              allLabel="Any"
              options={[
                { value: "DRAFT", label: "Drafts" },
                { value: "ISSUED", label: "Issued" },
                { value: "REVOKED", label: "Withdrawn" },
              ]}
            />
            {templates.length > 0 && (
              <SelectParamFilter
                paramName="template"
                label="Template"
                allLabel="Any letter"
                options={templates.map((t) => ({ value: t.id, label: t.name }))}
              />
            )}
          </div>
          {letters.rows.length === 0 ? (
            <Card className="px-4 py-12 text-center text-sm text-subtle">No letters match this filter.</Card>
          ) : (
            <Card className="overflow-hidden p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
                    <tr>
                      <th className="px-4 py-2.5">Letter</th>
                      <th className="px-4 py-2.5">For</th>
                      <th className="px-4 py-2.5">Kind</th>
                      <th className="px-4 py-2.5">Dated</th>
                      <th className="px-4 py-2.5">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {letters.rows.map((l) => (
                      <tr key={l.id} className="border-b border-line align-top last:border-0">
                        <td className="px-4 py-2.5">
                          <Link
                            href={l.status === "DRAFT" ? `/people/letters/${l.id}` : `/letters/${l.id}/print`}
                            target={l.status === "DRAFT" ? undefined : "_blank"}
                            className="text-brand hover:underline"
                          >
                            {l.subject}
                          </Link>
                          <div className="font-mono text-[11px] text-subtle">{l.letterNumber}</div>
                        </td>
                        <td className="px-4 py-2.5">
                          {l.user ? (
                            <Link href={personPath(l.user.userSeq)} className="text-text hover:underline">
                              {l.user.name}
                            </Link>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-muted">
                          {l.templateName ?? letterTypeLabels[l.type]}
                          {l.signed && <div className="text-xs text-subtle">Signed</div>}
                        </td>
                        {/* A @db.Date — the day it is dated. */}
                        <td className="px-4 py-2.5 text-muted">{formatCalendarDay(l.issuedOn)}</td>
                        <td className="px-4 py-2.5">
                          <Badge tone={l.status === "ISSUED" ? "green" : l.status === "REVOKED" ? "red" : "amber"}>{l.status}</Badge>
                          {l.issuedBy && <div className="mt-0.5 text-xs text-subtle">{l.issuedBy.name}</div>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
          <Pagination page={letters.page} pageSize={letters.pageSize} total={letters.total} totalPages={totalPages(letters.total, letters.pageSize)} pageSizes={[letters.pageSize]} />
        </div>
      )}

      {view === "templates" && (
        <div className="mt-4">
          <LetterTemplatesManager templates={templates} />
        </div>
      )}

      {view === "signature" && signature && (
        <div className="mt-4">
          <LetterSignaturePanel settings={signature} />
        </div>
      )}
    </div>
  );
}
