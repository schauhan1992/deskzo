import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { viewAsContext } from "@/lib/session";
import { Card } from "@/components/ui/card";
import { ChatApp } from "@/components/chat/chat-app";

/**
 * Team chat (src/lib/chat): the person's chats beside the one open. `?c=` opens a chat — a mention's
 * notification links here — and `?m=` one of its messages.
 */
export default async function ChatPage({ searchParams }: { searchParams: Promise<{ c?: string; m?: string }> }) {
  if (!(await isModuleEnabled("chat"))) return <ModuleDisabledNotice moduleKey="chat" />;
  // Chats are private: an admin viewing as somebody would be reading theirs.
  if (await viewAsContext()) {
    return (
      <Card className="mx-auto max-w-md px-6 py-10 text-center text-sm text-muted">
        Chat is private to each person, so it isn&apos;t shown while you&apos;re viewing as somebody else.
      </Card>
    );
  }
  const { c, m } = await searchParams;
  return (
    <div className="-my-2 md:-my-4">
      <h1 className="sr-only">Chat</h1>
      <ChatApp initialChatId={c ?? null} initialMessageId={m ?? null} />
    </div>
  );
}
