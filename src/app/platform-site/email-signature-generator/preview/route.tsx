import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { clientIpFrom } from "@/lib/client-ip";
import { layoutByKey } from "@/lib/signatures/premium";
import { renderPremiumPreview } from "@/lib/signatures/preview";
import { SAMPLE_SIGNATURE, type SignatureData } from "@/lib/signatures/render";

/**
 * A premium signature template as a watermarked PNG, filled with what the visitor typed on the
 * generator (`d`: base64url JSON of their details). Only premium templates are drawn here — the free
 * ones the page renders itself — and the answer is a picture, never the template's HTML.
 */
const MAX_DATA = 8192;

/**
 * Pictures per caller address a minute. A visitor typing makes eight every pause; a script making
 * thousands to burn the server's CPU meets this. In memory, bounded, rough by design.
 */
const PER_MINUTE = 120;
const recent = new Map<string, number[]>();
function allowed(ip: string | null, now = Date.now()): boolean {
  if (!ip) return true;
  const key = createHash("sha256").update(ip).digest("hex").slice(0, 24);
  const hits = (recent.get(key) ?? []).filter((t) => now - t < 60_000);
  if (hits.length >= PER_MINUTE) return false;
  hits.push(now);
  recent.delete(key);
  recent.set(key, hits);
  if (recent.size > 10_000) recent.delete(recent.keys().next().value!);
  return true;
}

function readData(encoded: string | null): SignatureData {
  if (!encoded || encoded.length > MAX_DATA) return SAMPLE_SIGNATURE;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return SAMPLE_SIGNATURE;
    const d = parsed as SignatureData;
    return typeof d.name === "string" && d.name.trim() ? d : { ...d, name: SAMPLE_SIGNATURE.name };
  } catch {
    return SAMPLE_SIGNATURE;
  }
}

export async function GET(req: Request) {
  if (!allowed(clientIpFrom(req.headers))) return new NextResponse("Too many requests", { status: 429, headers: { "Retry-After": "60" } });
  const url = new URL(req.url);
  const layout = layoutByKey(url.searchParams.get("t"));
  if (!layout || layout.tier !== "premium") return new NextResponse("Not found", { status: 404 });
  return renderPremiumPreview(layout, readData(url.searchParams.get("d")));
}
