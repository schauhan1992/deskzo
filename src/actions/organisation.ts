"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { hasEffectivePermission } from "@/actions/permission";
import { recordAudit } from "@/lib/audit";
import { GST_STATE_ABBREVIATIONS, GST_STATE_CODES, OTHER_COUNTRY_CODE, hasValidGstinChecksum, panOfGstin, stateCodeFromName } from "@/lib/gst-engine";
import { isIndia } from "@/lib/geo/countries";
import { ensureHeadOffice, type BranchWithRegistration } from "@/lib/branches/identity";
import { branchLabel } from "@/lib/branches/format";
import { organisationSettingsSchema, einvoiceSettingsSchema } from "@/lib/validation/trade-document";
import { reviewUrlSchema } from "@/lib/validation/feedback";
import { clampRating, MAX_RATING, MIN_RATING } from "@/lib/feedback/rating";
import type { ActionResult } from "@/actions/company";

const MAX_SIGNATURE_BYTES = 256 * 1024;

/** These details appear on every invoice we issue, so changing them is an admin-level act. */
async function requireSettingsAccess() {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "settings.manage"))) {
    return { user: null, error: "You can't change organisation settings." };
  }
  return { user, error: null };
}

// ─── The head office's registration, from the Profile ─────────────────────────
//
// The Profile's GSTIN field is the head office's registration (spec §11.3). These are the rules of
// src/actions/branch.ts, repeated rather than shared: a "use server" file can export only actions,
// and every one of those is an endpoint.

/** Where the registered office is, as GST sees it — the values being saved. */
type RegisteredOffice = { state: string | null; country: string | null; stateCode: string | null };

const stateName = (code: string) => GST_STATE_CODES[code] ?? code;

function panMismatch(gstinPan: string, orgPan: string) {
  return `That GSTIN belongs to PAN ${gstinPan}; this company's PAN is ${orgPan}. A different PAN is a different company — a separate workspace.`;
}

/** The head office's own address, or the registered office it inherits. */
function placeOf(branch: { addressLine1?: string | null; state?: string | null; country?: string | null }, office: RegisteredOffice) {
  const own = Boolean(branch.addressLine1?.trim());
  const from = own ? branch : office;
  const abroad = !isIndia(from.country);
  const stateCode = abroad ? null : ((own ? null : office.stateCode) ?? stateCodeFromName(from.state?.trim() || null));
  return { own, abroad, stateCode };
}

function registrationRefusal(place: ReturnType<typeof placeOf>, registration: { stateCode: string }, who: string): string | null {
  if (place.abroad) return "A branch outside India can't hold a GST registration — clear the GSTIN, or the country.";
  if (place.stateCode && place.stateCode !== registration.stateCode) {
    return `A GSTIN is state-specific — ${who} in ${stateName(place.stateCode)} can't use a ${stateName(registration.stateCode)} registration.`;
  }
  return null;
}

/** The state's short code (MH, KA…), with a digit appended while another registration has it. */
async function freeRegistrationCode(stateCode: string, exceptId?: string) {
  const base = GST_STATE_ABBREVIATIONS[stateCode] ?? stateCode;
  const rows = await db.gstRegistration.findMany({
    where: { code: { startsWith: base }, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
    select: { code: true },
  });
  const taken = new Set(rows.map((r) => r.code));
  let code = base;
  for (let n = 2; taken.has(code); n++) code = `${base}${n}`;
  return code;
}

const hasIssuedDocuments = async (gstRegistrationId: string) =>
  (await db.tradeDocument.count({ where: { gstRegistrationId, status: { not: "DRAFT" } } })) > 0;

type HeadOfficeSync =
  | { kind: "keep" }
  | { kind: "detach"; registrationId: string; label: string }
  | { kind: "attach"; registrationId: string; label: string }
  | { kind: "create"; gstin: string; stateCode: string; code: string; label: string }
  | { kind: "update"; registrationId: string; gstin: string; stateCode: string; code: string; label: string };

/**
 * What saving this GSTIN does to the head office's registration — decided before the transaction,
 * which then only writes. Blank lets it go (while nothing issued names it); the same GSTIN changes
 * nothing; a GSTIN already registered here is taken up; otherwise a head office without one gets a new
 * registration, and one with an unused registration has its GSTIN corrected.
 */
async function planHeadOfficeSync(gstin: string | null, headOffice: BranchWithRegistration, office: RegisteredOffice): Promise<HeadOfficeSync | { error: string }> {
  const current = headOffice.gstRegistration;
  if (!gstin) {
    if (!current) return { kind: "keep" };
    if (await hasIssuedDocuments(current.id)) {
      return {
        error: `GSTIN ${current.gstin} has issued documents, so the head office keeps it. To change registration, add the new one under Settings → Branches & GST registrations and make it the head office's.`,
      };
    }
    return { kind: "detach", registrationId: current.id, label: `head office GSTIN ${current.gstin} removed` };
  }
  if (current?.gstin === gstin) return { kind: "keep" };

  const place = placeOf(headOffice, office);
  const who = place.own ? "the head office" : "the registered office";
  const existing = await db.gstRegistration.findUnique({ where: { gstin }, select: { id: true, stateCode: true, active: true } });
  if (existing) {
    // Already one of this company's registrations: the head office takes it up, and keeps any it had.
    if (!existing.active) return { error: `GSTIN ${gstin} is inactive — reactivate it under Settings → Branches & GST registrations first.` };
    const refusal = registrationRefusal(place, existing, who);
    if (refusal) return { error: refusal };
    return { kind: "attach", registrationId: existing.id, label: `head office GSTIN ${gstin}` };
  }

  const stateCode = gstin.slice(0, 2);
  if (!GST_STATE_CODES[stateCode] || stateCode === OTHER_COUNTRY_CODE) {
    return { error: `${stateCode} isn't a GST state code — check the GSTIN's first two digits.` };
  }
  if (!hasValidGstinChecksum(gstin)) return { error: "That GSTIN's check digit is wrong — check it against the registration certificate." };
  const refusal = registrationRefusal(place, { stateCode }, who);
  if (refusal) return { error: refusal };

  if (!current) return { kind: "create", gstin, stateCode, code: await freeRegistrationCode(stateCode), label: `head office GSTIN ${gstin}` };

  // Correcting the GSTIN is only safe while nothing issued carries the old one.
  if (await hasIssuedDocuments(current.id)) {
    return {
      error: `GSTIN ${current.gstin} has issued documents. To change registration, add the new one under Settings → Branches & GST registrations and make it the head office's.`,
    };
  }
  if (current.stateCode !== stateCode) {
    // Any other branch on it moves state with it.
    const others = await db.branch.findMany({
      where: { gstRegistrationId: current.id, NOT: { id: headOffice.id } },
      select: { name: true, code: true, isHeadOffice: true, addressLine1: true, state: true, country: true },
    });
    for (const branch of others) {
      const moved = registrationRefusal(placeOf(branch, office), { stateCode }, branchLabel(branch));
      if (moved) return { error: moved };
    }
  }
  // A code still at its state's default follows the state; one somebody chose stays.
  const defaultCode = current.stateCode !== stateCode && current.code === (GST_STATE_ABBREVIATIONS[current.stateCode] ?? current.stateCode);
  const code = defaultCode ? await freeRegistrationCode(stateCode, current.id) : current.code;
  return { kind: "update", registrationId: current.id, gstin, stateCode, code, label: `head office GSTIN ${current.gstin} → ${gstin}` };
}

export async function updateOrganisation(input: unknown): Promise<ActionResult<{ ok: true }>> {
  const { user, error } = await requireSettingsAccess();
  if (!user) return { ok: false, error: error! };

  const parsed = organisationSettingsSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;
  const blank = (value: string | undefined) => (value ? value : null);

  // Resolved before the transaction: ensureHeadOffice may write, and must never run inside one.
  const [headOffice, stored] = await Promise.all([
    ensureHeadOffice(),
    db.organisationSettings.findUnique({ where: { id: "global" }, select: { pan: true } }),
  ]);

  // An input without `gstin` at all leaves the head office's registration, and the mirror, as they are —
  // for a Profile that shows the field read-only (a head office away from the registered office).
  const gstinSent = data.gstin !== undefined;
  const gstin = blank(data.gstin?.trim().toUpperCase());
  const gstinPan = panOfGstin(gstinSent ? gstin : headOffice.gstRegistration?.gstin);
  const typedPan = blank(data.pan?.trim().toUpperCase());

  const fields = {
    legalName: data.legalName.trim(),
    tradeName: blank(data.tradeName),
    // Kept on the organisation row as the previous build's copy (rollback); the head office's
    // registration, synced below, is what everything now reads.
    gstin: gstinSent ? gstin : undefined,
    // A blank PAN is the GSTIN's own: characters 3–12.
    pan: typedPan ?? gstinPan,
    cin: blank(data.cin?.toUpperCase()),
    addressLine1: blank(data.addressLine1),
    addressLine2: blank(data.addressLine2),
    city: blank(data.city),
    state: blank(data.state),
    // The state code drives the CGST/SGST-vs-IGST decision, so fall back to the GSTIN's own prefix
    // rather than leaving it unset and silently taxing every sale as inter-state.
    stateCode: blank(data.stateCode) ?? (data.gstin ? data.gstin.slice(0, 2) : null),
    pincode: blank(data.pincode),
    country: blank(data.country),
    email: blank(data.email),
    phone: blank(data.phone),
    bankName: blank(data.bankName),
    bankAccountNumber: blank(data.bankAccountNumber),
    bankIfsc: blank(data.bankIfsc?.toUpperCase()),
    bankBranch: blank(data.bankBranch),
    upiId: blank(data.upiId),
    invoiceTerms: blank(data.invoiceTerms),
    invoiceNotes: blank(data.invoiceNotes),
    roundOffTotals: data.roundOffTotals,
  };

  const plan: HeadOfficeSync | { error: string } = gstinSent
    ? await planHeadOfficeSync(gstin, headOffice, { state: fields.state, country: fields.country, stateCode: fields.stateCode })
    : { kind: "keep" };
  if ("error" in plan) return { ok: false, error: plan.error };

  // One PAN, one company (spec §3.4 rule 2). Checked when the PAN or the GSTIN changes, so a mismatch
  // already on file doesn't stop somebody saving their bank details.
  const panChanges = fields.pan !== (stored?.pan ?? null);
  if (typedPan && gstinPan && typedPan !== gstinPan && (panChanges || plan.kind !== "keep")) {
    return { ok: false, error: panMismatch(gstinPan, typedPan) };
  }
  if (fields.pan && panChanges) {
    // Every other registration carries the PAN too. The one being corrected is about to lose its old GSTIN.
    const replaced = plan.kind === "update" ? plan.registrationId : null;
    const registrations = await db.gstRegistration.findMany({ select: { id: true, gstin: true } });
    const other = registrations.find((r) => r.id !== replaced && panOfGstin(r.gstin) && panOfGstin(r.gstin) !== fields.pan);
    if (other) {
      return {
        ok: false,
        error: `GSTIN ${other.gstin} belongs to PAN ${panOfGstin(other.gstin)}. A company has one PAN, so it can't become ${fields.pan} while that registration is here.`,
      };
    }
  }

  try {
    await db.$transaction(async (tx) => {
      await tx.organisationSettings.upsert({
        where: { id: "global" },
        create: { id: "global", ...fields },
        update: fields,
      });
      if (plan.kind === "create") {
        // Not set up for e-invoicing until somebody enters its IRP login — never quietly the mock portal (spec §7.1).
        const created = await tx.gstRegistration.create({
          data: { gstin: plan.gstin, stateCode: plan.stateCode, code: plan.code, einvoiceProvider: null, createdById: user.id },
          select: { id: true },
        });
        await tx.branch.update({ where: { id: headOffice.id }, data: { gstRegistrationId: created.id }, select: { id: true } });
      } else if (plan.kind === "attach") {
        await tx.branch.update({ where: { id: headOffice.id }, data: { gstRegistrationId: plan.registrationId }, select: { id: true } });
      } else if (plan.kind === "update") {
        await tx.gstRegistration.update({
          where: { id: plan.registrationId },
          data: { gstin: plan.gstin, stateCode: plan.stateCode, code: plan.code },
          select: { id: true },
        });
      } else if (plan.kind === "detach") {
        await tx.branch.update({ where: { id: headOffice.id }, data: { gstRegistrationId: null }, select: { id: true } });
        // Deleted only when nothing else names it: another branch, a draft, a ledger line or a series keeps it.
        const uses = await tx.gstRegistration.findUnique({
          where: { id: plan.registrationId },
          select: { _count: { select: { branches: true, documents: true, journalLines: true, documentSeries: true } } },
        });
        if (uses && Object.values(uses._count).every((n) => n === 0)) {
          await tx.gstRegistration.delete({ where: { id: plan.registrationId }, select: { id: true } });
        }
      }
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && (err.code === "P2002" || err.code === "P2003")) {
      return { ok: false, error: "The GST registrations changed while this was being saved — reload and try again." };
    }
    throw err;
  }

  const notes = [plan.kind !== "keep" && plan.label, !typedPan && gstinPan && panChanges && "PAN taken from the GSTIN"].filter(Boolean);
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "OrganisationSettings",
    entityId: "global",
    entityLabel: `Organisation details${notes.length ? ` — ${notes.join("; ")}` : ""}`,
  });
  revalidatePath("/settings/organisation");
  revalidatePath("/settings/branches");
  if (plan.kind !== "keep") {
    for (const path of ["/settings/einvoicing", "/settings/eway", "/settings/numbering"]) revalidatePath(path);
  }
  return { ok: true, data: { ok: true } };
}

/**
 * The company-wide e-invoicing switch and minimum value (spec §7.1). The IRP login is per GST
 * registration now — `saveRegistrationEInvoice` in src/actions/branch.ts — so the credential fields an
 * older form still sends are ignored, and the organisation's own copy of them is left as it is.
 */
export async function updateEInvoiceSettings(input: unknown): Promise<ActionResult<{ ok: true }>> {
  const { user, error } = await requireSettingsAccess();
  if (!user) return { ok: false, error: error! };

  const parsed = einvoiceSettingsSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;

  const fields = {
    einvoiceEnabled: data.einvoiceEnabled,
    einvoiceMinValue: data.einvoiceMinValue ?? null,
  };

  await db.organisationSettings.upsert({
    where: { id: "global" },
    create: { id: "global", legalName: "", ...fields },
    update: fields,
  });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "OrganisationSettings",
    entityId: "global",
    entityLabel: `E-invoicing ${data.einvoiceEnabled ? "enabled" : "disabled"}`,
  });
  revalidatePath("/settings/organisation");
  revalidatePath("/settings/einvoicing");
  return { ok: true, data: { ok: true } };
}

/**
 * The signature/stamp printed on issued documents. Stored as a data URL for the same reason as the
 * branding images — no writable disk is assumed anywhere in this deployment.
 */
export async function uploadSignature(dataUrl: string): Promise<ActionResult<{ ok: true }>> {
  const { user, error } = await requireSettingsAccess();
  if (!user) return { ok: false, error: error! };

  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) return { ok: false, error: "Use a PNG, JPEG or WebP image." };
  // Base64 is 4 characters per 3 bytes, so the encoded length bounds the decoded size closely enough.
  if ((match[2].length * 3) / 4 > MAX_SIGNATURE_BYTES) {
    return { ok: false, error: "That image is over 256KB — use a smaller one." };
  }

  await db.organisationSettings.upsert({
    where: { id: "global" },
    create: { id: "global", legalName: "", signatureDataUrl: dataUrl },
    update: { signatureDataUrl: dataUrl },
  });

  revalidatePath("/settings/organisation");
  return { ok: true, data: { ok: true } };
}

export async function removeSignature(): Promise<ActionResult<{ ok: true }>> {
  const { user, error } = await requireSettingsAccess();
  if (!user) return { ok: false, error: error! };

  await db.organisationSettings.update({ where: { id: "global" }, data: { signatureDataUrl: null } });
  revalidatePath("/settings/organisation");
  return { ok: true, data: { ok: true } };
}

// ─── Letterhead ───────────────────────────────────────────────────────────────

/**
 * The paper HR letters are printed on.
 *
 * Deliberately separate from the app's branding. The mark at the top of an appointment letter is the
 * employer's; the one in the sidebar is the software's. They are usually the same image, and this
 * falls back to the branding logo when no letterhead logo is set — but an employer who white-labels
 * the app would otherwise be signing letters with somebody else's mark.
 */
export async function updateLetterhead(input: {
  letterheadFooter?: string;
  letterNumberPrefix?: string;
  letterSignatoryName?: string;
  letterSignatoryTitle?: string;
}): Promise<ActionResult<{ ok: true }>> {
  const { user, error } = await requireSettingsAccess();
  if (!user) return { ok: false, error: error! };

  const prefix = (input.letterNumberPrefix ?? "").trim().toUpperCase();
  // The prefix goes into a reference number people quote back at you, and into a column that is
  // unique — a space or a slash would produce numbers nobody can read out over the phone.
  if (prefix && !/^[A-Z0-9-]{2,10}$/.test(prefix)) {
    return { ok: false, error: "The prefix should be 2–10 letters, digits or hyphens — it goes into every letter number." };
  }

  const fields = {
    letterheadFooter: input.letterheadFooter?.trim() || null,
    letterNumberPrefix: prefix || "WRF",
    letterSignatoryName: input.letterSignatoryName?.trim() || null,
    letterSignatoryTitle: input.letterSignatoryTitle?.trim() || null,
  };

  await db.organisationSettings.upsert({
    where: { id: "global" },
    create: { id: "global", legalName: "", ...fields },
    update: fields,
  });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "OrganisationSettings",
    entityId: "global",
    entityLabel: "Letterhead",
  });
  revalidatePath("/settings/organisation");
  return { ok: true, data: { ok: true } };
}

export async function uploadLetterheadLogo(dataUrl: string): Promise<ActionResult<{ ok: true }>> {
  const { user, error } = await requireSettingsAccess();
  if (!user) return { ok: false, error: error! };

  const match = /^data:(image\/(?:png|jpeg|webp|svg\+xml));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) return { ok: false, error: "Use a PNG, JPEG, WebP or SVG image." };
  if ((match[2].length * 3) / 4 > MAX_SIGNATURE_BYTES) {
    return { ok: false, error: "That image is over 256KB — use a smaller one." };
  }

  await db.organisationSettings.upsert({
    where: { id: "global" },
    create: { id: "global", legalName: "", letterheadLogoDataUrl: dataUrl },
    update: { letterheadLogoDataUrl: dataUrl },
  });
  revalidatePath("/settings/organisation");
  return { ok: true, data: { ok: true } };
}

export async function removeLetterheadLogo(): Promise<ActionResult<{ ok: true }>> {
  const { user, error } = await requireSettingsAccess();
  if (!user) return { ok: false, error: error! };
  await db.organisationSettings.update({ where: { id: "global" }, data: { letterheadLogoDataUrl: null } });
  revalidatePath("/settings/organisation");
  return { ok: true, data: { ok: true } };
}

/**
 * How feedback links behave, and who gets offered the public review page.
 *
 * The threshold is stored rather than hard-coded because it is the one decision in the feedback
 * module with a policy attached to it: Google's review policy prohibits soliciting reviews only
 * from customers you already know are happy. Setting it to 1 offers the page to everybody, which
 * is the compliant setting. Whatever it is set to, every response is recorded here in full —
 * the threshold decides where somebody is sent, never whether their answer is kept.
 */
export async function updateFeedbackSettings(input: {
  feedbackReviewUrl?: string;
  feedbackReviewMinRating?: number;
  feedbackLinkDays?: number;
  feedbackIntro?: string;
}): Promise<ActionResult<{ ok: true }>> {
  const { user, error } = await requireSettingsAccess();
  if (!user) return { ok: false, error: error! };

  const parsedUrl = reviewUrlSchema.safeParse(input.feedbackReviewUrl ?? "");
  if (!parsedUrl.success) {
    return { ok: false, error: parsedUrl.error.issues[0]?.message ?? "That review link isn't a web address." };
  }

  const days = Math.min(365, Math.max(1, Math.round(input.feedbackLinkDays ?? 30)));
  const minRating = clampRating(input.feedbackReviewMinRating ?? 4);

  const fields = {
    feedbackReviewUrl: parsedUrl.data?.trim() || null,
    feedbackReviewMinRating: minRating,
    feedbackLinkDays: days,
    feedbackIntro: input.feedbackIntro?.trim() || null,
  };

  await db.organisationSettings.upsert({
    where: { id: "global" },
    create: { id: "global", legalName: "", ...fields },
    update: fields,
  });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "OrganisationSettings",
    entityId: "global",
    // Spelled out in the audit trail, because "who decided to only ask happy customers" is exactly
    // the question somebody asks six months later.
    entityLabel:
      minRating <= MIN_RATING
        ? "Feedback — every customer is offered the public review page"
        : `Feedback — only ${minRating}/${MAX_RATING} and above are offered the public review page`,
  });
  revalidatePath("/settings/organisation");
  revalidatePath("/feedback");
  return { ok: true, data: { ok: true } };
}

/**
 * How marketing behaves before anything reaches a provider.
 *
 * Quiet hours and the non-working-day skip are not politeness settings — a campaign that lands at
 * 2am on a Sunday tells a customer nobody here knows what day it is. The frequency cap is the one
 * that stops four separate campaigns, each perfectly reasonable on its own, from arriving in one
 * morning.
 */
export async function updateMarketingSettings(input: {
  marketingFromDomain?: string;
  marketingPostalAddress?: string;
  marketingQuietStartMinute?: number;
  marketingQuietEndMinute?: number;
  marketingSkipNonWorkingDays?: boolean;
  marketingMaxPerContactPerWeek?: number;
  marketingApprovalThreshold?: number;
}): Promise<ActionResult<{ ok: true }>> {
  const { user, error } = await requireSettingsAccess();
  if (!user) return { ok: false, error: error! };

  const minute = (value: number | undefined, fallback: number) =>
    Math.min(1439, Math.max(0, Math.round(value ?? fallback)));

  // Pasted addresses arrive in every shape — with a scheme, with a trailing path, with an @ in
  // front. Pulled apart with string operations rather than a regex, which is easier to read and
  // harder to get subtly wrong.
  const raw = (input.marketingFromDomain ?? "").trim().toLowerCase();
  const withoutScheme = raw.includes("://") ? raw.slice(raw.indexOf("://") + 3) : raw;
  const withoutUser = withoutScheme.includes("@") ? withoutScheme.slice(withoutScheme.indexOf("@") + 1) : withoutScheme;
  const domain = withoutUser.split("/")[0].trim() || null;
  if (domain && (!domain.includes(".") || /[^a-z0-9.-]/.test(domain))) {
    return { ok: false, error: "That isn't a domain — just the part after the @, like mail.acme.com." };
  }

  const fields = {
    marketingFromDomain: domain,
    marketingPostalAddress: input.marketingPostalAddress?.trim() || null,
    marketingQuietStartMinute: minute(input.marketingQuietStartMinute, 1200),
    marketingQuietEndMinute: minute(input.marketingQuietEndMinute, 540),
    marketingSkipNonWorkingDays: input.marketingSkipNonWorkingDays ?? true,
    // 0 disables the cap rather than blocking everything — see `withinFrequencyCap`.
    marketingMaxPerContactPerWeek: Math.max(0, Math.round(input.marketingMaxPerContactPerWeek ?? 2)),
    marketingApprovalThreshold: Math.max(1, Math.round(input.marketingApprovalThreshold ?? 200)),
  };

  await db.organisationSettings.upsert({
    where: { id: "global" },
    create: { id: "global", legalName: "", ...fields },
    update: fields,
  });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "OrganisationSettings",
    entityId: "global",
    entityLabel: `Marketing — ${fields.marketingMaxPerContactPerWeek === 0 ? "no frequency cap" : `at most ${fields.marketingMaxPerContactPerWeek} a week per contact`}, approval above ${fields.marketingApprovalThreshold}`,
  });
  revalidatePath("/settings/organisation");
  revalidatePath("/marketing");
  return { ok: true, data: { ok: true } };
}
