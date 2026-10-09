import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { getBooksStatus } from "@/actions/books";
import { currentUser } from "@/lib/session";
import { getOrganisation } from "@/lib/organisation";
import { ReportHeader } from "@/components/accounting/report-chrome";
import { BooksManager } from "@/components/accounting/books-manager";
import { can } from "@/lib/authz/resolve";
import { notFound } from "next/navigation";
import { viewerHas } from "@/actions/permission";

export default async function BooksPage() {
  const enabled = await isModuleEnabled("accounting");
  if (!enabled) return <ModuleDisabledNotice moduleKey="accounting" />;
  // For whoever closes the books, and the ledger reports' readers who see what is locked — its link's
  // terms. Anybody else gets the 404 any address they can't open gets.
  if (!(await viewerHas("books.close")) && !(await viewerHas("ledger.viewReports"))) notFound();

  const [status, user, org] = await Promise.all([getBooksStatus(), currentUser(), getOrganisation()]);

  return (
    <div className="animate-fade-rise">
      <ReportHeader
        title="Close the books"
        subtitle="A period lock, and the year-end entry that moves profit into reserves"
        organisation={org.legalName}
      />
      <div className="mt-5">
        <BooksManager status={status} isAdmin={user ? await can(user.id, "books.close") : false} />
      </div>
    </div>
  );
}
