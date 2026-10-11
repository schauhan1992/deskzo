import { NextResponse, type NextRequest } from "next/server";
import { clientIpFrom } from "@/lib/client-ip";
import { recordClick } from "@/lib/signatures/clicks";

/**
 * A click on a signature's banner or button — /s/<token>, rewritten here by the proxy
 * (src/lib/signatures/clicks.ts). Whoever clicked is reading an email: nobody is signed in, and nothing
 * about them is kept. Counted (or not), then sent on to the link as it is now; the click address itself
 * isn't passed on as a referrer, since it names whose signature it was.
 */

export const dynamic = "force-dynamic";

const ENDED = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Link ended</title></head><body style="font-family:Arial,Helvetica,sans-serif;color:#333;max-width:28rem;margin:4rem auto;padding:0 1rem;"><h1 style="font-size:1.25rem;">This link has ended</h1><p>It was in an email signature, and what it pointed to is no longer there.</p></body></html>`;

async function handle(req: NextRequest, params: Promise<{ token: string }>) {
  const { token } = await params;
  const outcome = await recordClick({
    token,
    method: req.method,
    userAgent: req.headers.get("user-agent"),
    purpose: req.headers.get("sec-purpose") ?? req.headers.get("purpose"),
    ip: clientIpFrom(req.headers),
  });
  const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex" };
  if (!outcome.target) return new NextResponse(ENDED, { status: 410, headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
  return NextResponse.redirect(outcome.target, { status: 302, headers });
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  return handle(req, params);
}

/** A link checker's HEAD: sent on, never counted. */
export async function HEAD(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  return handle(req, params);
}
