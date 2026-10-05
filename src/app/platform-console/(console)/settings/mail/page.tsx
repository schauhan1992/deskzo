import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Banner } from "@/components/console/kit/banner";
import { PageHeader } from "@/components/console/kit/page-header";
import { StatusPill } from "@/components/console/kit/status";
import { MailSettings } from "@/components/console/settings/mail-settings";
import { PAGE_ROLES } from "@/lib/console-shared/nav";
import { capsFor, hasRole } from "@/lib/console-shared/roles";
import { consoleStaff } from "@/lib/platform/console-page";
import { mailSetup } from "@/lib/platform/mail/store";

export const metadata: Metadata = { title: "Mail" };

/**
 * Settings › Mail (owner, 5 Oct 2026; src/lib/platform/mail): the accounts the platform's own mail
 * goes through — Microsoft 365, Amazon SES, Elastic Email, SendGrid, Brevo, Mailgun, Postmark or any
 * SMTP server — and which one each type of mail uses. Settings' own gate; only an owner changes
 * anything (src/actions/platform/console-mail.ts checks again). No secret reaches the page.
 */
export default async function ConsoleMailSettingsPage() {
  const staff = await consoleStaff(PAGE_ROLES.settings);
  const caps = capsFor(staff.role);
  // Null until the release's migration has made the mail tables (src/lib/platform/mail).
  const setup = await mailSetup().catch(() => null);
  const seesLog = hasRole(staff.role, PAGE_ROLES.mail ?? []);

  return (
    <>
      <PageHeader
        title="Mail"
        chips={caps.owner ? undefined : <StatusPill tone="neutral">View only</StatusPill>}
        subtitle="The accounts the platform's own mail goes through — signup codes, password links, billing reminders, helpdesk replies, alerts — and which one each type uses."
        actions={
          <div className="flex flex-wrap gap-x-5 gap-y-1">
            <Link href="/settings" className="inline-flex items-center gap-1 text-[13px] font-medium text-brand hover:underline">
              All settings
            </Link>
            {seesLog && (
              <Link href="/mail" className="inline-flex items-center gap-1 text-[13px] font-medium text-brand hover:underline">
                Mail log
                <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
              </Link>
            )}
          </div>
        }
      />
      {setup ? (
        <MailSettings setup={setup} canEdit={caps.owner} testTo={staff.email} />
      ) : (
        <Banner tone="warning" title="Not ready yet">
          {"This release's database migrations haven't run here, so there are no mail settings to show. Run npm run tenants:migrate, then reload."}
        </Banner>
      )}
    </>
  );
}
