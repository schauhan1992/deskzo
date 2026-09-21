import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { auth } from "@/lib/auth";

/**
 * Serves a user's profile photo as an actual image.
 *
 * The alternative — embedding the data URL in the page — puts the whole image in the HTML of every
 * screen that shows an avatar, uncached, once per occurrence. A list of twenty people would carry
 * twenty copies. Serving it here means the browser treats it like any other image: one request,
 * then a 304 for the rest of the day.
 *
 * `/api` is outside the proxy's matcher (see src/proxy.ts), so the session is checked here rather
 * than inherited. That check is the point — these are photographs of employees, not public assets.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) {
    return new NextResponse("Not found", { status: 404 });
  }

  const { id } = await params;
  const photo = await db.userPhoto.findUnique({
    where: { userId: id },
    select: { dataUrl: true, mimeType: true, updatedAt: true },
  });
  // 404 rather than a placeholder: the caller knows from `photoUpdatedAt` whether to ask, so a
  // request landing here for somebody with no photo is a caller bug worth seeing rather than
  // papering over with a generated image.
  if (!photo) return new NextResponse("Not found", { status: 404 });

  const base64 = photo.dataUrl.slice(photo.dataUrl.indexOf(",") + 1);
  const bytes = Buffer.from(base64, "base64");

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": photo.mimeType,
      "Content-Length": String(bytes.length),
      /**
       * `private` because this is one employee's face and must not sit in a shared proxy cache.
       * Immutable with a long max-age is safe despite that: callers append `?v=<photoUpdatedAt>`,
       * so a new photo is a new URL rather than something the browser has to be told to re-fetch.
       */
      "Cache-Control": "private, max-age=31536000, immutable",
      ETag: `"${photo.updatedAt.getTime()}"`,
      // Belt and braces against a file that claims one type and contains another.
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
    },
  });
}
