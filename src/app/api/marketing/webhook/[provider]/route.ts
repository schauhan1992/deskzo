import { NextResponse } from "next/server";
import type { MessageEventType, MessageStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { isMarketingWebhookSecret } from "@/lib/marketing/webhook-secret";

/**
 * What the provider tells us afterwards.
 *
 * This closes a loop the app has never been able to close. `docs/ROADMAP.md` records it plainly:
 * an email check proves the domain, not the mailbox, and "there is no bounce feedback loop either —
 * nothing in the app sends mail yet, so nothing can learn from a bounce". Now something does, so a
 * hard bounce writes a suppression *and* marks the contact's address INVALID, and the next campaign
 * never tries it again.
 *
 * Authentication is the workspace's own secret (src/lib/marketing/webhook-secret.ts) rather than a
 * per-provider signature. Every provider signs
 * differently — Resend uses Svix headers, SES wraps events in SNS envelopes, Elastic posts plain
 * JSON — and a wrong signature check fails closed and silently loses delivery data. The secret goes
 * in the URL the provider is configured with, which never appears in a browser. Worth upgrading to
 * real signature verification per provider once one of them is actually in use.
 */

export const dynamic = "force-dynamic";

async function authorised(request: Request): Promise<boolean> {
  const provided =
    new URL(request.url).searchParams.get("key")?.trim() ??
    request.headers.get("x-webhook-secret")?.trim() ??
    "";
  return isMarketingWebhookSecret(provided);
}

type Normalised = {
  providerMessageId: string | null;
  /** Some providers identify by recipient rather than by message id. */
  email: string | null;
  type: MessageEventType | null;
  url: string | null;
  providerEventId: string | null;
  detail: string | null;
  /** A soft bounce is a transient failure and must not suppress anybody. */
  hard: boolean;
};

const TYPE_MAP: Record<string, MessageEventType> = {
  delivered: "DELIVERED",
  delivery: "DELIVERED",
  open: "OPEN",
  opened: "OPEN",
  click: "CLICK",
  clicked: "CLICK",
  bounce: "BOUNCE",
  bounced: "BOUNCE",
  complaint: "COMPLAINT",
  complained: "COMPLAINT",
  spamreport: "COMPLAINT",
  unsubscribe: "UNSUBSCRIBE",
  unsubscribed: "UNSUBSCRIBE",
  failed: "FAILED",
  error: "FAILED",
};

/** Flattens the three shapes into one. Anything unrecognised is stored and otherwise ignored. */
function normalise(provider: string, body: Record<string, unknown>): Normalised {
  const pick = (...paths: string[]): string | null => {
    for (const path of paths) {
      const value = path.split(".").reduce<unknown>((acc, key) => (acc as Record<string, unknown>)?.[key], body);
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return null;
  };

  const rawType = (pick("type", "event", "eventType", "Event", "notificationType", "data.type") ?? "")
    .toLowerCase()
    .replace(/^email\./, "");
  const type = TYPE_MAP[rawType] ?? null;

  const subType = (pick("bounce.bounceType", "data.bounce_type", "BounceType") ?? "").toLowerCase();
  // Only a permanent failure suppresses. A full mailbox or a greylisting will clear on its own, and
  // treating it as permanent quietly loses a customer.
  const hard = type === "BOUNCE" ? subType !== "transient" && subType !== "soft" : false;

  return {
    providerMessageId: pick("data.email_id", "message_id", "messageId", "MessageID", "mail.messageId", "data.id"),
    email: pick("data.to.0", "to", "recipient", "Recipient", "data.email", "mail.destination.0")?.toLowerCase() ?? null,
    type,
    url: pick("data.click.link", "url", "Url", "click.link"),
    providerEventId: pick("data.id", "id", "eventId", "EventID"),
    detail: pick("data.reason", "reason", "Reason", "bounce.bouncedRecipients.0.diagnosticCode", "description"),
    hard,
  };
}

/** A later state never walks back to an earlier one. A bounce that later reports an open is bounced. */
const RANK: Partial<Record<MessageStatus, number>> = {
  QUEUED: 0,
  SENDING: 1,
  SENT: 2,
  DELIVERED: 3,
  OPENED: 4,
  CLICKED: 5,
  BOUNCED: 6,
  COMPLAINED: 7,
  FAILED: 6,
};

const STATUS_FOR: Partial<Record<MessageEventType, MessageStatus>> = {
  DELIVERED: "DELIVERED",
  OPEN: "OPENED",
  CLICK: "CLICKED",
  BOUNCE: "BOUNCED",
  COMPLAINT: "COMPLAINED",
  FAILED: "FAILED",
};

export async function POST(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  if (!(await authorised(request))) return NextResponse.json({ ok: false }, { status: 401 });
  const { provider } = await params;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "Not JSON." }, { status: 400 });
  }

  const event = normalise(provider, body);
  if (!event.type) {
    // Acknowledged rather than rejected: a provider that gets a 4xx will retry forever, and an
    // event type we do not model is not an error.
    return NextResponse.json({ ok: true, ignored: true });
  }

  const message = event.providerMessageId
    ? await db.marketingMessage.findFirst({
        where: { providerMessageId: event.providerMessageId },
        select: { id: true, status: true, contactId: true, toEmail: true },
      })
    : event.email
      ? await db.marketingMessage.findFirst({
          where: { toEmail: event.email, status: { in: ["SENT", "DELIVERED", "OPENED", "CLICKED"] } },
          orderBy: { sentAt: "desc" },
          select: { id: true, status: true, contactId: true, toEmail: true },
        })
      : null;

  if (message) {
    try {
      await db.messageEvent.create({
        data: {
          messageId: message.id,
          type: event.type,
          url: event.url,
          providerEventId: event.providerEventId,
          detail: event.detail,
        },
      });
    } catch {
      // The unique index on providerEventId did its job — this is a replay, and replays are normal.
      return NextResponse.json({ ok: true, duplicate: true });
    }

    const next = STATUS_FOR[event.type];
    if (next && (RANK[next] ?? 0) > (RANK[message.status] ?? 0)) {
      await db.marketingMessage.update({ where: { id: message.id }, data: { status: next } });
    }
  }

  const address = (event.email ?? message?.toEmail)?.trim().toLowerCase() ?? null;

  // The part that matters: a permanent failure or a complaint takes the address out of circulation,
  // and a bounce also corrects the contact's own verification verdict.
  if (address && ((event.type === "BOUNCE" && event.hard) || event.type === "COMPLAINT")) {
    await db.suppression.upsert({
      where: { scope_value: { scope: "EMAIL", value: address } },
      create: {
        scope: "EMAIL",
        value: address,
        reason: event.type === "COMPLAINT" ? "COMPLAINT" : "HARD_BOUNCE",
        note: `Reported by ${provider}${event.detail ? `: ${event.detail}` : ""}`,
      },
      update: { reason: event.type === "COMPLAINT" ? "COMPLAINT" : "HARD_BOUNCE" },
    });

    if (event.type === "BOUNCE") {
      await db.contact.updateMany({
        where: { email: address },
        data: {
          emailStatus: "INVALID",
          emailCheckedValue: address,
          emailCheckedAt: new Date(),
          emailCheckMethod: "REPORTED",
          emailCheckDetail: `Mail to this address bounced${event.detail ? `: ${event.detail}` : "."}`,
        },
      });
    }
  }

  if (address && event.type === "UNSUBSCRIBE") {
    await db.suppression.upsert({
      where: { scope_value: { scope: "EMAIL", value: address } },
      create: { scope: "EMAIL", value: address, reason: "UNSUBSCRIBED", note: `Unsubscribed via ${provider}.` },
      update: { reason: "UNSUBSCRIBED" },
    });
    if (message?.contactId) {
      await db.journeyEnrolment.updateMany({
        where: { contactId: message.contactId, status: "ACTIVE" },
        data: { status: "EXITED", exitedAt: new Date(), exitReason: "They unsubscribed", nextRunAt: null },
      });
    }
  }

  return NextResponse.json({ ok: true, matched: !!message });
}
