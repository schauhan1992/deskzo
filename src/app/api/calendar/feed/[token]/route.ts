import { NextResponse, type NextRequest } from "next/server";
import { readFeed } from "@/lib/calendar/feed";

/**
 * A person's subscribe link — /api/calendar/feed/<secret>.ics (src/lib/calendar/feed.ts). Whatever asks is
 * a calendar app, signed in as nobody: the secret is the whole of it. Never cached anywhere on the way,
 * never indexed, never passed on as a referrer; a secret that isn't one gets the same plain 404 as a
 * workspace without Calendar.
 */

export const dynamic = "force-dynamic";

const HEADERS = { "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow, noarchive", "referrer-policy": "no-referrer" };

export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const read = await readFeed(token.replace(/\.ics$/i, ""));
  if (!read.ok) {
    return new NextResponse(read.status === 429 ? "Asked too often — try again later." : "Not found.", {
      status: read.status,
      headers: { ...HEADERS, "content-type": "text/plain; charset=utf-8", ...(read.status === 429 ? { "retry-after": "3600" } : {}) },
    });
  }
  return new NextResponse(read.ics, { status: 200, headers: { ...HEADERS, "content-type": "text/calendar; charset=utf-8", "content-disposition": 'inline; filename="deskzo.ics"' } });
}
