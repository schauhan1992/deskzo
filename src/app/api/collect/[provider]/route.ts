import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { confirmLink } from "@/lib/collect/links";
import { notMigratedYet } from "@/lib/not-migrated";

/**
 * A gateway saying one of this workspace's pay-now links changed (owner, 23 Oct 2026 — src/lib/collect).
 *
 * Never believed: it only names a link, which is then read back from the gateway with the business's own keys
 * (`confirmLink`) — so a forged notice can't record a payment, and nothing here depends on how each gateway
 * signs. A link asked about in the last half-minute isn't asked again, so a flood of notices is a handful of
 * calls. Unknown links, and anything unreadable, are answered 200 so the gateway stops retrying.
 *
 *   · Razorpay: set on the business's Razorpay dashboard, events payment_link.* — the link is
 *     payload.payment_link.entity.id.
 *   · Cashfree: given with each link (link_meta.notify_url) — the link is data.link_id, as JSON or form data.
 */

const ASKED_WITHIN_MS = 30_000;

function linkIdFrom(provider: "RAZORPAY" | "CASHFREE", raw: string, contentType: string): string | null {
  try {
    if (provider === "RAZORPAY") {
      const body = JSON.parse(raw) as { payload?: { payment_link?: { entity?: { id?: unknown } } } };
      const id = body.payload?.payment_link?.entity?.id;
      return typeof id === "string" ? id : null;
    }
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const form = new URLSearchParams(raw);
      const direct = form.get("link_id") ?? form.get("linkId");
      if (direct) return direct;
      const data = form.get("data");
      return data ? (((JSON.parse(data) as { link_id?: unknown }).link_id as string) ?? null) : null;
    }
    const body = JSON.parse(raw) as { data?: { link_id?: unknown } };
    return typeof body.data?.link_id === "string" ? body.data.link_id : null;
  } catch {
    return null;
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider: segment } = await params;
  const provider = segment === "razorpay" ? "RAZORPAY" : segment === "cashfree" ? "CASHFREE" : null;
  if (!provider) return NextResponse.json({ ok: false }, { status: 404 });

  const raw = (await request.text()).slice(0, 200_000);
  const providerLinkId = linkIdFrom(provider, raw, request.headers.get("content-type") ?? "");
  if (!providerLinkId) return NextResponse.json({ ok: true, ignored: "no link named" });

  try {
    const link = await db.paymentLink.findFirst({
      where: { providerLinkId, gateway: { provider } },
      select: { id: true, status: true, checkedAt: true },
    });
    if (!link || link.status !== "ACTIVE") return NextResponse.json({ ok: true });
    if (link.checkedAt && Date.now() - link.checkedAt.getTime() < ASKED_WITHIN_MS) return NextResponse.json({ ok: true, asked: "recently" });
    const outcome = await confirmLink(link.id);
    return NextResponse.json({ ok: true, outcome });
  } catch (err) {
    if (notMigratedYet(err)) return NextResponse.json({ ok: true });
    console.error("collect notice failed", err);
    // A 500 has the gateway try again later, which is what's wanted when something here broke.
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
