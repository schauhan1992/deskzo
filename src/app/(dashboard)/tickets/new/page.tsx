import { notFound } from "next/navigation";
import { listCompanyOptions } from "@/actions/company";
import { listCompanyOrderOptions, listSupportAgents } from "@/actions/ticket";
import { isModuleEnabled } from "@/actions/module";
import { hasEffectivePermission } from "@/actions/permission";
import { currentUser } from "@/lib/session";
import { NewTicketForm } from "@/components/tickets/new-ticket-form";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";

export default async function NewTicketPage({
  searchParams,
}: {
  searchParams: Promise<{ companyId?: string }>;
}) {
  if (!(await isModuleEnabled("helpdesk"))) return <ModuleDisabledNotice moduleKey="helpdesk" />;
  const sessionUser = await currentUser();
  const userId = sessionUser!.id;
  const canCreate = await hasEffectivePermission(userId, "tickets.create");
  if (!canCreate) notFound();

  const itemsEnabled = await isModuleEnabled("items");
  const [{ companyId }, companies, users] = await Promise.all([
    searchParams,
    listCompanyOptions(),
    listSupportAgents(),
  ]);
  const initialOrders = companyId && itemsEnabled ? await listCompanyOrderOptions(companyId) : [];

  return (
    <div>
      <h1 className="text-xl font-semibold text-text">New ticket</h1>
      <p className="mt-1 text-sm text-muted">Log a support request against a company.</p>
      <div className="mt-6">
        <NewTicketForm
          companies={companies}
          initialCompanyId={companyId}
          itemsEnabled={itemsEnabled}
          initialOrders={initialOrders}
          users={users}
        />
      </div>
    </div>
  );
}
