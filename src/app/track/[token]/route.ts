import { NextResponse } from "next/server";
import { destinationIsOurs } from "@/lib/marketing/tracking";
import { db } from "@/lib/db";

/**
 * Open and click tracking.
 *
 * `/track/<token>` on its own is the open pixel; `/track/<token>?u=<url>` is a click, recorded and
 * then redirected. Both are deliberately forgiving: an unknown token, a replayed request, a
 * database that is briefly unavailable — none of them may stop the customer getting where they
 * were going. A tracking failure is our problem, not theirs.
 *
 * Open tracking is a weak signal and worth saying so: a mail client that pre-fetches images records
 * an open nobody had, and one that blocks them records nothing from somebody who read every word.
 * A click is the number to trust.
 */

export const dynamic = "force-dynamic";

/** A 1×1 transparent GIF, the smallest thing that can be an image. */
const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

function pixelResponse() {
  return new NextResponse(new Uint8Array(PIXEL), {
    headers: {
      "Content-Type": "image/gif",
      // Never cached, or the second open is invisible.
      "Cache-Control": "no-store, no-cache, must-revalidate, private",
      "Content-Length": String(PIXEL.length),
    },
  });
}

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const query = new URL(request.url).searchParams;
  const target = query.get("u");

  /**
   * Parsed here, but not yet trusted.
   *
   * The comment that used to sit here said "only somewhere we were told to go" and nothing checked:
   * any http(s) URL was followed, with no valid token required. That made this an open redirect on
   * the domain the company sends its invoices from — the single most useful host a phishing link
   * could have. A destination is only followed below, once the token resolves to a real message and
   * the signature proves we minted the pair. See src/lib/marketing/tracking.ts.
   */
  let candidate: URL | null = null;
  if (target) {
    try {
      const parsed = new URL(target);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") candidate = parsed;
    } catch {
      candidate = null;
    }
  }

  let destination: URL | null = null;

  try {
    const message = await db.marketingMessage.findUnique({
      where: { token },
      select: { id: true, status: true },
    });

    // Both, in this order: an unknown token never redirects, and a known token only redirects to a
    // destination it was issued with.
    if (message && candidate && destinationIsOurs(token, target!, query.get("s"))) {
      destination = candidate;
    }

    if (message) {
      const type = destination ? "CLICK" : "OPEN";
      await db.messageEvent.create({
        data: { messageId: message.id, type, url: destination?.toString() ?? null },
      });
      // A click implies an open, and neither may walk the status backwards from something further
      // along — a bounced message that later reports an open is still bounced.
      const advances = destination
        ? ["SENT", "DELIVERED", "OPENED"]
        : ["SENT", "DELIVERED"];
      if (advances.includes(message.status)) {
        await db.marketingMessage.update({
          where: { id: message.id },
          data: { status: destination ? "CLICKED" : "OPENED" },
        });
      }
    }
  } catch (err) {
    console.error("tracking failed", err);
  }

  if (destination) return NextResponse.redirect(destination.toString(), 302);
  return pixelResponse();
}
