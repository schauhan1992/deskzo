import { NextResponse } from "next/server";
import { layoutByKey } from "@/lib/signatures/premium";
import { renderPremiumPreview } from "@/lib/signatures/preview";
import { SAMPLE_SIGNATURE, type SignatureData } from "@/lib/signatures/render";

/**
 * A premium signature template as a watermarked PNG, filled with what the visitor typed on the
 * generator (`d`: base64url JSON of their details). Only premium templates are drawn here — the free
 * ones the page renders itself — and the answer is a picture, never the template's HTML.
 */
const MAX_DATA = 4096;

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
  const url = new URL(req.url);
  const layout = layoutByKey(url.searchParams.get("t"));
  if (!layout || layout.tier !== "premium") return new NextResponse("Not found", { status: 404 });
  return renderPremiumPreview(layout, readData(url.searchParams.get("d")));
}
