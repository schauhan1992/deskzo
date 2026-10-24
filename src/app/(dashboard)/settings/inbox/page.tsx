import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { planGate } from "@/components/settings/module-disabled-notice";
import { InboxSettings } from "@/components/inbox/inbox-settings";
import { can } from "@/lib/authz/resolve";
import { db } from "@/lib/db";
import { assignablePeople, inboxSettings } from "@/lib/inbox/server";
import { channelSettings, type InboxKind } from "@/lib/inbox/settings";
import { aiService } from "@/lib/ai/gateway";
import { currentUser } from "@/lib/session";
import { protocolFor } from "@/lib/tenancy/host";

/**
 * Settings › Customer inbox (owner, 24 Oct 2026; src/lib/inbox): the website bubbles and WhatsApp numbers
 * conversations come in on, each with its bot's set answers and whether new customers become leads, and
 * the workspace's WhatsApp credentials and webhook. No secret is sent to the page — only whether one is set.
 */
export default async function InboxSettingsPage() {
  const gate = await planGate("inbox", "Customer inbox");
  if (gate) return gate;
  const user = await currentUser();
  if (!user || !(await can(user.id, "settings.manage"))) notFound();

  const host = (await headers()).get("host") ?? "";
  const origin = `${protocolFor(host)}://${host}`;
  const [channels, settings, people, provider, ai] = await Promise.all([
    db.inboxChannel.findMany({ orderBy: { createdAt: "asc" }, include: { _count: { select: { conversations: true } } } }),
    inboxSettings(),
    assignablePeople(),
    db.messagingProvider.findFirst({ where: { kind: "WHATSAPP", key: "whatsapp_cloud", enabled: true }, select: { id: true, secretCipher: true } }),
    // Where Deskzo AI's answers would go, said before anybody switches them on; null until staff route the feature.
    aiService("inbox.answer").catch(() => null),
  ]);
  const read = channels.map((c) => ({ c, settings: channelSettings(c.settings, c.kind as InboxKind) }));
  const chargedIds = [...new Set(read.map((r) => r.settings.bot.ai.chargedTo).filter((v): v is string => !!v))];
  const charged = new Map((await db.user.findMany({ where: { id: { in: chargedIds } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-text">Customer inbox</h1>
        <p className="mt-1 text-sm text-muted">
          Website chats and WhatsApp messages, answered from one inbox. Each channel has a bot that answers from your own set answers and hands over to a person.
        </p>
      </div>
      <InboxSettings
        origin={origin}
        people={people}
        ai={ai ? { model: ai.model, residency: ai.residency, noTraining: ai.noTraining } : null}
        channels={read.map(({ c, settings: s }) => ({
          id: c.id,
          kind: c.kind as InboxKind,
          name: c.name,
          active: c.active,
          publicKey: c.publicKey,
          phoneNumberId: c.phoneNumberId,
          displayPhone: c.displayPhone,
          ownerUserId: c.ownerUserId,
          settings: s,
          conversations: c._count.conversations,
          aiChargedTo: s.bot.ai.chargedTo ? (charged.get(s.bot.ai.chargedTo) ?? "somebody who has left") : null,
        }))}
        whatsapp={{
          webhookUrl: `${origin}/api/inbox/public/whatsapp`,
          verifyToken: settings.whatsappVerifyToken,
          hasAppSecret: !!settings.whatsappAppSecretCipher,
          hasToken: !!settings.whatsappTokenCipher,
          providerToken: !!provider?.secretCipher,
          language: settings.whatsappLanguage ?? "",
        }}
      />
    </div>
  );
}
