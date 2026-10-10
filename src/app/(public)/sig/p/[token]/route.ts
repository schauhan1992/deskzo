import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { userFromPhotoToken } from "@/lib/signatures/server";
import { dataUrlImage } from "@/lib/signatures/images";

/**
 * A person's photo in their email signature. The token is their id with a MAC under the workspace's
 * key (src/lib/signatures/server.ts), so it can't be guessed or turned into anybody else's. Gone when
 * their account is switched off, the company stops showing photos, or Signatures leaves the plan.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!(await moduleAvailableForTenant("signatures"))) return new NextResponse("Not found", { status: 404 });
  const userId = await userFromPhotoToken(token);
  if (!userId) return new NextResponse("Not found", { status: 404 });
  const [user, settings] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { active: true, photo: { select: { dataUrl: true } } } }),
    db.signatureSettings.findUnique({ where: { id: "global" }, select: { showPhoto: true } }),
  ]);
  if (!user?.active || settings?.showPhoto === false) return new NextResponse("Not found", { status: 404 });
  return dataUrlImage(user.photo?.dataUrl, 600);
}
