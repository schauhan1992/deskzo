import Link from "next/link";
import { isModuleEnabled } from "@/actions/module";
import { listSupportInbox } from "@/actions/support-mail";
import { listCompanyOptions } from "@/actions/company";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { SupportInbox } from "@/components/tickets/support-inbox";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Helpdesk → Support inbox: emails to the helpdesk address waiting for somebody to decide where they
 * belong (src/actions/support-mail.ts). For whoever may open tickets.
 */
export default async function SupportInboxPage() {
  if (!(await isModuleEnabled("helpdesk"))) return <ModuleDisabledNotice moduleKey="helpdesk" />;
  const emails = await listSupportInbox();

  return (
    <div>
      <Link href="/tickets" className="text-sm text-muted hover:text-text">
        ← Tickets
      </Link>
      <h1 className="mt-1 text-xl font-semibold text-text">Support inbox</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted">
        Emails to your helpdesk address that couldn&apos;t find their ticket by themselves — from somebody who isn&apos;t a
        contact yet, or a reply from an address that isn&apos;t on the ticket it names. Your address and how to forward to it
        are in <Link href="/settings/support-email" className="underline">Settings → Support email</Link>.
      </p>
      <div className="mt-5">
        {emails === null ? (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted">Only people who can open tickets can sort the Support inbox.</CardContent>
          </Card>
        ) : (
          <SupportInbox emails={emails} companies={await listCompanyOptions({ withContacts: false })} />
        )}
      </div>
    </div>
  );
}
