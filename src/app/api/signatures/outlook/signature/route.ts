import { NextResponse, type NextRequest } from "next/server";
import { clientIpFrom } from "@/lib/client-ip";
import { outlookSignature } from "@/lib/signatures/outlook";

/**
 * A person's signature, for the Outlook add-in (src/lib/signatures/outlook.ts) — asked each time they
 * start a message, with the address of the mailbox it runs in. Nobody is signed in: Outlook's add-in
 * runtime carries no session of ours. Under /api, so the proxy only asks which workspace.
 *
 * Any origin may read it: it carries no cookie and answers nothing a caller couldn't get by being sent
 * an email, and the add-in's runtime in classic Outlook for Windows has no origin of ours to name.
 */

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const answer = await outlookSignature(req.nextUrl.searchParams.get("email"), clientIpFrom(req.headers));
  return NextResponse.json(answer.body, {
    status: answer.status,
    headers: { "cache-control": "no-store", "access-control-allow-origin": "*", "x-content-type-options": "nosniff" },
  });
}
