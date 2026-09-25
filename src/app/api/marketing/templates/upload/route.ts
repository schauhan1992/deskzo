import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import type { MarketingTopic } from "@prisma/client";
import { recordAudit } from "@/lib/audit";
import { TOPICS } from "@/lib/marketing/topics";
import { storeUploadedTemplate } from "@/lib/marketing/template-store";
import { checkUploadRequest } from "@/lib/marketing/upload-request";
import { UPLOAD_LIMITS } from "@/lib/marketing/template-upload";

/**
 * Upload an HTML email template: one .html file, or a .zip of it with its pictures. Creates a
 * template, or replaces the body of one (`id`). See src/lib/marketing/template-store.ts for what
 * happens to the file.
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const gate = await checkUploadRequest(request, UPLOAD_LIMITS.fileBytes + 64 * 1024);
  if (!gate.ok) return NextResponse.json({ ok: false, error: gate.error }, { status: gate.status });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ ok: false, error: "That upload didn't arrive whole — try again." }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return NextResponse.json({ ok: false, error: "Choose an .html or .zip file." }, { status: 400 });
  const topic = String(form.get("topic") ?? "OFFERS") as MarketingTopic;
  if (!TOPICS.some((t) => t.key === topic)) return NextResponse.json({ ok: false, error: "Pick what the email is about." }, { status: 400 });
  const id = String(form.get("id") ?? "") || undefined;

  const stored = await storeUploadedTemplate({
    userId: gate.userId,
    id,
    name: String(form.get("name") ?? file.name.replace(/\.(zip|html?)$/i, "")),
    topic,
    subject: String(form.get("subject") ?? "") || null,
    preheader: String(form.get("preheader") ?? "") || null,
    fileName: file.name,
    bytes: Buffer.from(await file.arrayBuffer()),
  });
  if (!stored.ok) return NextResponse.json(stored, { status: 422 });

  await recordAudit({
    userId: gate.userId,
    action: id ? "UPDATE" : "CREATE",
    entityType: "MarketingTemplate",
    entityId: stored.data.id,
    entityLabel: `Uploaded from ${file.name}`,
  });
  revalidatePath("/marketing/templates");
  revalidatePath("/marketing/send");
  return NextResponse.json(stored);
}
