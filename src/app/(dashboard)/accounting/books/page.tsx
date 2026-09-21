import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { getBooksStatus } from "@/actions/books";
import { currentUser } from "@/lib/session";
import { getOrganisation } from "@/lib/organisation";
import { ReportHeader } from "@/components/accounting/report-chrome";
import { BooksManager } from "@/components/accounting/books-manager";
import { can } from "@/lib/authz/resolve";

export default async function BooksPage() {
  const enabled = await isModuleEnabled("accounting");
  if (!enabled) return <ModuleDisabledNotice moduleKey="accounting" />;

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
