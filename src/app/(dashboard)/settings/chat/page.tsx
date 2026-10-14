import { notFound } from "next/navigation";
import { currentUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { db } from "@/lib/db";
import { chatSettings } from "@/lib/chat/server";
import { planGate } from "@/components/settings/module-disabled-notice";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ChatSettingsForm, ChatExportPanel } from "@/components/chat/chat-settings";

/**
 * Settings → Chat: whether files sent in chat can be saved, and how long messages are kept — and, for
 * the super admin alone, exporting one chat (owner, 15 Oct 2026). Nobody, the super admin included,
 * reads chats here.
 */
export default async function ChatSettingsPage() {
  const gate = await planGate("chat", "Chat");
  if (gate) return gate;
  const user = await currentUser();
  if (!user || !(await can(user.id, "settings.manage"))) notFound();
  const [settings, me] = await Promise.all([chatSettings(), db.user.findUnique({ where: { id: user.id }, select: { isSuperAdmin: true } })]);

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-text">Chat</h1>
        <p className="mt-1 text-sm text-muted">
          Messages and files stay in this workspace&apos;s own database, and only the people in a chat can read it — admins included.
        </p>
      </div>

      <Card>
        <CardHeader>
          <h2 className="text-sm font-medium text-text">Files and keeping messages</h2>
        </CardHeader>
        <CardContent>
          <ChatSettingsForm initial={settings} />
        </CardContent>
      </Card>

      {me?.isSuperAdmin && (
        <Card>
          <CardHeader>
            <h2 className="text-sm font-medium text-text">Export a chat</h2>
            <p className="mt-0.5 text-xs text-muted">
              For an investigation or a legal request. Find the chat by a person&apos;s or a group&apos;s name — you see who is in it, never what was
              said — and export it as text. Every export is recorded in the audit trail and the activity log.
            </p>
          </CardHeader>
          <CardContent>
            <ChatExportPanel />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
