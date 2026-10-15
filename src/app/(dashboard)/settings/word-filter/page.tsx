import { notFound } from "next/navigation";
import { currentUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { wordFilterSettings } from "@/lib/word-filter/server";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { WordFilterForm } from "@/components/settings/word-filter-form";
import { planGate } from "@/components/settings/module-disabled-notice";

/**
 * Settings → Word filter (owner, 15 Oct 2026): the words chat and tickets each keep out — Deskzo's preset
 * of abusive words in English, Hindi and Hinglish, and the workspace's own. A section for each of the two
 * that is switched on.
 */
export default async function WordFilterPage() {
  const gate = await planGate(["chat", "helpdesk"], "Word filter");
  if (gate) return gate;
  const user = await currentUser();
  if (!user || !(await can(user.id, "settings.manage"))) notFound();
  const [chatOn, ticketsOn] = await Promise.all([moduleAvailableForTenant("chat"), moduleAvailableForTenant("helpdesk")]);
  if (!chatOn && !ticketsOn) notFound();
  const [chat, tickets] = await Promise.all([chatOn ? wordFilterSettings("CHAT") : null, ticketsOn ? wordFilterSettings("TICKETS") : null]);

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-text">Word filter</h1>
        <p className="mt-1 text-sm text-muted">
          Words your company keeps out of {chatOn && ticketsOn ? "chat and tickets" : chatOn ? "chat" : "tickets"}. Each has its own list, and is off until
          you switch it on.
        </p>
      </div>

      {chat && (
        <Card>
          <CardHeader>
            <h2 className="text-sm font-medium text-text">Chat</h2>
          </CardHeader>
          <CardContent>
            <WordFilterForm area="CHAT" initial={chat} />
          </CardContent>
        </Card>
      )}

      {tickets && (
        <Card>
          <CardHeader>
            <h2 className="text-sm font-medium text-text">Tickets</h2>
          </CardHeader>
          <CardContent>
            <WordFilterForm area="TICKETS" initial={tickets} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
