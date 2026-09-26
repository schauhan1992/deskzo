import { NextResponse } from "next/server";
import { onPlatformHost } from "@/lib/billing/platform-request";
import { receiveRazorpayWebhook } from "@/lib/billing/webhooks";

/**
 * Razorpay's webhook — set in Razorpay's dashboard to https://admin.<domain>/api/platform/billing/razorpay,
 * with its secret entered in the console. Signed, processed once, see src/lib/billing/webhooks.ts.
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!onPlatformHost(request)) return new NextResponse("Not found.", { status: 404 });
  const raw = await request.text();
  const answer = await receiveRazorpayWebhook(raw, request.headers.get("x-razorpay-signature"), request.headers.get("x-razorpay-event-id"));
  return new NextResponse(answer.body, { status: answer.status, headers: { "content-type": "text/plain; charset=utf-8" } });
}
