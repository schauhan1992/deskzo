import type { Metadata } from "next";
import { ExternalLink, FileText, Globe, Inbox, Newspaper, ShieldCheck } from "lucide-react";
import { consoleCmsAdminLink } from "@/actions/platform/console-website";
import { KpiTile } from "@/components/console/charts/kpi-tile";
import { ActionButton } from "@/components/console/kit/action-button";
import { EmptyState } from "@/components/console/kit/empty-state";
import { PageHeader } from "@/components/console/kit/page-header";
import { Panel } from "@/components/console/kit/panel";
import { StatusPill } from "@/components/console/kit/status";
import { DataTable, RowActionsCell, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { OutboundLink } from "@/components/ui/outbound-link";
import { BUILTIN_PAGE_SLUGS } from "@/lib/cms/types";
import { cmsAdminCount, cmsOrigin, listCmsUsers } from "@/lib/cms/users";
import { when } from "@/lib/console-shared/format";
import { PAGE_ROLES } from "@/lib/console-shared/nav";
import { capsFor } from "@/lib/console-shared/roles";
import { consoleStaff } from "@/lib/platform/console-page";
import { controlDb } from "@/lib/platform/control-db";
import { InviteCmsAdminButton } from "./invite-cms-admin";

export const metadata: Metadata = { title: "Website CMS" };

const num = (n: number) => n.toLocaleString("en-IN");

/** What the CMS holds, in three numbers — read here, not in the CMS's own code, and nothing from inside a document. */
async function websiteCounts(now = new Date()) {
  const control = controlDb();
  const [pagesPublished, builtinsPublished, postsLive, leadsNew] = await Promise.all([
    control.sitePage.count({ where: { status: "PUBLISHED", archivedAt: null } }),
    control.sitePage.count({ where: { status: "PUBLISHED", archivedAt: null, slug: { in: [...BUILTIN_PAGE_SLUGS] } } }),
    control.sitePost.count({ where: { status: { in: ["PUBLISHED", "SCHEDULED"] }, archivedAt: null, publishAt: { lte: now } } }),
    control.siteLead.count({ where: { status: "NEW" } }),
  ]);
  // Built-in pages nobody has published still show their default content on the site.
  return { pages: pagesPublished + (BUILTIN_PAGE_SLUGS.length - builtinsPublished), pagesFromCms: pagesPublished, postsLive, leadsNew };
}

/**
 * The website's CMS, from the console (owners and admins): where it is, what it holds, and its admins.
 * The CMS is its own app with its own accounts at cms.<domain> — staff do not sign in to it. This page
 * is how it gets its first admin (an owner invites one; `npm run cms:user` does the same from the
 * server), and how an admin who lost their way in gets a new setup link.
 */
export default async function ConsoleWebsitePage() {
  const staff = await consoleStaff(PAGE_ROLES.website);
  const caps = capsFor(staff.role);
  const [admins, activeAdmins, counts] = await Promise.all([listCmsUsers({ role: "ADMIN" }), cmsAdminCount(), websiteCounts()]);
  const origin = cmsOrigin();
  const host = origin.replace(/^https?:\/\//, "");

  return (
    <>
      <PageHeader
        title="Website CMS"
        subtitle={`The public website's editor, at ${host} — its own app and accounts, apart from staff and every workspace.`}
        actions={
          <>
            <OutboundLink
              href={origin}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-base border border-line-strong bg-surface px-3 text-[13px] font-medium whitespace-nowrap text-text shadow-sm hover:bg-surface-sunken"
            >
              <ExternalLink aria-hidden="true" className="h-4 w-4" />
              Open the CMS
              <span className="sr-only">(opens in a new tab)</span>
            </OutboundLink>
            {caps.owner && <InviteCmsAdminButton />}
          </>
        }
      />

      <div className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-3">
          <KpiTile
            label="Pages on the site"
            value={num(counts.pages)}
            icon={<FileText className="h-4 w-4" />}
            secondary={counts.pagesFromCms ? `${num(counts.pagesFromCms)} published from the CMS` : "All showing their default content"}
          />
          <KpiTile label="Posts published" value={num(counts.postsLive)} icon={<Newspaper className="h-4 w-4" />} secondary="On the blog now" />
          <KpiTile label="New leads" value={num(counts.leadsNew)} icon={<Inbox className="h-4 w-4" />} secondary="From the contact form, not yet handled" tone={counts.leadsNew ? "info" : "neutral"} />
        </div>

        <Panel
          title="CMS admins"
          description="They manage the CMS's own accounts and security. Editors, authors and viewers are added by them, inside the CMS."
          padded={admins.length === 0}
        >
          {admins.length === 0 ? (
            <EmptyState
              icon={<Globe className="h-5 w-5" />}
              title="No CMS admin yet"
              body={
                caps.owner
                  ? "Invite the first one: they get an email with a link to choose a password, then add the rest of the team inside the CMS."
                  : "An owner invites the first one from here, or it is made on the server with npm run cms:user."
              }
              action={caps.owner ? <InviteCmsAdminButton /> : undefined}
            />
          ) : (
            <DataTable caption="CMS admins" minWidth={640}>
              <THead>
                <Th>Name</Th>
                <Th>Status</Th>
                <Th>Two-factor</Th>
                <Th>Last signed in</Th>
                <Th srOnly>Actions</Th>
              </THead>
              <TBody>
                {admins.map((admin) => (
                  <Tr key={admin.id}>
                    <Td>
                      <span className="block font-medium">{admin.name}</span>
                      <span className="block text-xs text-muted">{admin.email}</span>
                    </Td>
                    <Td>
                      {!admin.active ? (
                        <StatusPill tone="neutral">Switched off</StatusPill>
                      ) : !admin.hasPassword ? (
                        <StatusPill tone={admin.setupPending ? "info" : "warning"}>{admin.setupPending ? "Invited" : "Link expired"}</StatusPill>
                      ) : (
                        <StatusPill tone="success">Active</StatusPill>
                      )}
                    </Td>
                    <Td muted>
                      {admin.twoFactor ? (
                        <span className="inline-flex items-center gap-1 text-success">
                          <ShieldCheck aria-hidden="true" className="h-3.5 w-3.5" />
                          On
                        </span>
                      ) : (
                        "Not set up"
                      )}
                    </Td>
                    <Td muted nowrap>
                      {admin.lastSignInAt ? when(admin.lastSignInAt) : "Never"}
                    </Td>
                    <RowActionsCell>
                      {admin.active && (
                        <ActionButton
                          action={consoleCmsAdminLink.bind(null, admin.id)}
                          label="Send a new setup link…"
                          variant="ghost"
                          success={`A new setup link was emailed to ${admin.email}.`}
                          confirm={{
                            title: `Send ${admin.name} a new setup link?`,
                            body: "They get an email with a link to choose a new password, valid for three days. Any earlier link stops working; their current password keeps working until they use it.",
                            confirmLabel: "Send link",
                          }}
                        />
                      )}
                    </RowActionsCell>
                  </Tr>
                ))}
              </TBody>
            </DataTable>
          )}
        </Panel>

        {activeAdmins === 1 && (
          <p className="text-xs text-muted">
            There is one active CMS admin. The CMS never lets its last admin be removed, but a second one means nobody is locked out when a phone is lost.
          </p>
        )}
      </div>
    </>
  );
}
