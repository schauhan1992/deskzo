import Link from "next/link";
import { notFound } from "next/navigation";
import { MessageSquareMore } from "lucide-react";
import { isModuleEnabled } from "@/actions/module";
import { inboxConversation, inboxList, inboxPeople } from "@/actions/inbox";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { InboxApp } from "@/components/inbox/inbox-app";
import { Card } from "@/components/ui/card";
import { can } from "@/lib/authz/resolve";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/session";

/**
 * The Customer inbox (owner, 24 Oct 2026; src/lib/inbox): website chat and WhatsApp in one place. `?c=`
 * opens a conversation — CNV-000123, as a notification links it.
 */
export default async function InboxPage({ searchParams }: { searchParams: Promise<{ c?: string }> }) {
  if (!(await isModuleEnabled("inbox"))) return <ModuleDisabledNotice moduleKey="inbox" />;
  const user = await currentUser();
  if (!user) notFound();
  const [channels, settingsAllowed] = await Promise.all([
    db.inboxChannel.findMany({ where: { active: true }, select: { id: true, name: true, kind: true }, orderBy: { createdAt: "asc" } }),
    can(user.id, "settings.manage"),
  ]);

  if (channels.length === 0) {
    return (
      <Card className="mx-auto max-w-lg px-6 py-10 text-center">
        <MessageSquareMore aria-hidden="true" className="mx-auto h-8 w-8 text-subtle" />
        <h1 className="mt-3 text-base font-semibold text-text">Customer inbox</h1>
        <p className="mt-2 text-sm text-muted">
          Website chats and WhatsApp messages land here. There&apos;s nothing to bring them in yet — add your website&apos;s chat bubble or a WhatsApp number first.
        </p>
        {settingsAllowed ? (
          <Link href="/settings/inbox" className="mt-4 inline-flex h-9 items-center rounded-base bg-brand px-3.5 text-sm font-medium text-brand-contrast hover:brightness-110">
            Set it up
          </Link>
        ) : (
          <p className="mt-4 text-xs text-subtle">An admin sets it up in Settings › Customer inbox.</p>
        )}
      </Card>
    );
  }

  const { c } = await searchParams;
  const [mine, people, detail, canLeads, canTickets] = await Promise.all([
    inboxList({ view: "mine" }),
    inboxPeople(),
    c ? inboxConversation(c) : null,
    (async () => (await isModuleEnabled("leads")) && (await can(user.id, "leads.view")))(),
    (async () => (await isModuleEnabled("helpdesk")) && (await can(user.id, "tickets.create")))(),
  ]);
  // Start on what's mine; with nothing mine, on every open conversation.
  const view = mine.length ? "mine" : "open";
  const rows = mine.length ? mine : await inboxList({ view: "open" });

  return (
    <div className="-my-2 md:-my-4">
      <h1 className="sr-only">Customer inbox</h1>
      <InboxApp
        meId={user.id}
        channels={channels.map((ch) => ({ id: ch.id, name: ch.name, kind: ch.kind }))}
        people={people}
        initialRows={rows}
        initialView={view}
        initialDetail={detail}
        canMakeLead={canLeads}
        canMakeTicket={canTickets}
      />
    </div>
  );
}
