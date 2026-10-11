import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { userOfPhotoToken } from "@/lib/signatures/person";

/**
 * A person's photo, for their email signature — fetched by whoever's mail program shows it, so nobody
 * is signed in. The address names one person and carries a MAC under the workspace's key
 * (src/lib/signatures/person.ts), so it can't be made up for anybody else. It answers only while
 * Signatures is in the plan and the person's account is active.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const missing = () => new NextResponse("Not found", { status: 404 });
  if (!(await moduleAvailableForTenant("signatures"))) return missing();
  const userId = await userOfPhotoToken((await params).token);
  if (!userId) return missing();
  const person = await db.user.findUnique({ where: { id: userId }, select: { active: true, photo: { select: { dataUrl: true, mimeType: true } } } });
  if (!person?.active || !person.photo) return missing();

  const bytes = Buffer.from(person.photo.dataUrl.slice(person.photo.dataUrl.indexOf(",") + 1), "base64");
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": person.photo.mimeType,
      "Content-Length": String(bytes.length),
      // The address carries the photo's version, so a new photo is a new address.
      "Cache-Control": "public, max-age=86400",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
    },
  });
}
