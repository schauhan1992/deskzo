import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import type { MarketingTopic } from "@prisma/client";
import { recordAudit } from "@/lib/audit";
import { TOPICS } from "@/lib/marketing/topics";
import { importMarketingList } from "@/lib/marketing/list-import";
import { checkUploadRequest } from "@/lib/marketing/upload-request";

/**
 * Upload a list of people for a mass mail, as a CSV. Every row becomes a contact before anybody is
 * mailed — see src/lib/marketing/list-import.ts — and nothing happens without the uploader saying
 * how these people agreed to hear from us.
 */

export const dynamic = "force-dynamic";

const MAX_CSV_BYTES = 5 * 1024 * 1024;

export async function POST(request: Request) {
  const gate = await checkUploadRequest(request, MAX_CSV_BYTES + 64 * 1024);
  if (!gate.ok) return NextResponse.json({ ok: false, error: gate.error }, { status: gate.status });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ ok: false, error: "That upload didn't arrive whole — try again." }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return NextResponse.json({ ok: false, error: "Choose a .csv file." }, { status: 400 });
  if (file.size > MAX_CSV_BYTES) return NextResponse.json({ ok: false, error: "That CSV is over 5 MB — split it into smaller lists." }, { status: 413 });
  if (!/\.(csv|txt)$/i.test(file.name)) return NextResponse.json({ ok: false, error: "Upload the list as a .csv — Excel can save one with File › Save As." }, { status: 400 });

  const name = String(form.get("name") ?? "").trim();
  if (!name) return NextResponse.json({ ok: false, error: "Give the list a name." }, { status: 400 });
  // Consent is the uploader's statement, and the send is refused without it. DPDP asks for the
  // artefact, not a tick: the words become the evidence on every consent row.
  if (form.get("confirmed") !== "yes") return NextResponse.json({ ok: false, error: "Confirm that these people agreed to hear from us." }, { status: 400 });
  const consentNote = String(form.get("consentNote") ?? "").trim();
  if (consentNote.length < 10) return NextResponse.json({ ok: false, error: "Say how they agreed — for example “signed up at our Pune roundtable on 12 Sep”." }, { status: 400 });
  const topics = form.getAll("topics").map(String).filter((t): t is MarketingTopic => TOPICS.some((x) => x.key === t));
  if (topics.length === 0) return NextResponse.json({ ok: false, error: "Pick what they agreed to hear about." }, { status: 400 });

  const imported = await importMarketingList({
    userId: gate.userId,
    name: name.slice(0, 120),
    fileName: file.name.slice(0, 200),
    csvText: await file.text(),
    consentNote: consentNote.slice(0, 500),
    topics,
  });
  if (!imported.ok) return NextResponse.json(imported, { status: 422 });

  await recordAudit({
    userId: gate.userId,
    action: "CREATE",
    entityType: "MarketingList",
    entityId: imported.data.listId,
    entityLabel: `${name} — ${imported.data.rows} people from ${file.name} (${imported.data.createdContacts} new contacts)`,
  });
  revalidatePath("/marketing/send");
  revalidatePath("/marketing/lists");
  return NextResponse.json(imported);
}
