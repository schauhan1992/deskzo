"use server";

/**
 * Branches and GST registrations: the settings screen's reads, every write to either, and where
 * somebody works.
 *
 * The rules are spec §3.4's, enforced here rather than trusted to the form: a GSTIN is checked against
 * its check digit and the company's PAN, a branch against its registration's state, and anything a
 * document, payment or ledger line names is retired rather than deleted. Who "we" are on a document is
 * `src/lib/branches/identity.ts`; its helpers may write, so they are called before a transaction opens,
 * never inside one.
 *
 * Nothing here selects or returns a cipher column. Whether a registration holds a password or a client
 * secret is asked of the database (`storedSecrets`), so the settings screen never has one to leak.
 */
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { hasEffectivePermission } from "@/actions/permission";
import { actorContext, assertMayActOnTarget, AuthzError } from "@/lib/authz/guards";
import { recordAudit } from "@/lib/audit";
import { encryptSecret } from "@/lib/crypto";
import { GST_STATE_CODES, OTHER_COUNTRY_CODE, hasValidGstinChecksum, panOfGstin, stateCodeFromName } from "@/lib/gst-engine";
import { isIndia } from "@/lib/geo/countries";
import { ensureHeadOffice, listBranchChoices } from "@/lib/branches/identity";
import { branchLabel, formatDispatchAddress, mergeIdentity, type BranchChoice } from "@/lib/branches/format";
import { branchSchema, gstRegistrationSchema, registrationEInvoiceSchema } from "@/lib/validation/branch";
import type { ActionResult } from "@/actions/company";

const MAX_IMAGE_BYTES = 256 * 1024;

const CODE_TAKEN = "That code is already used";
const GSTIN_TAKEN = "That GSTIN is already registered";

/** One of this company's GST registrations, as the settings screens show it. */
export type RegistrationRow = {
  id: string;
  gstin: string;
  stateCode: string;
  stateName: string;
  code: string;
  active: boolean;
  isHeadOffice: boolean;
  branchCount: number;
  /** Documents past draft that name it — while there are any, its GSTIN can't change. */
  issuedDocumentCount: number;
  /** False for a GSTIN stored before check digits were verified (legacy data): the screen asks to check it. */
  checksumOk: boolean;
  /** False when characters 3–12 are not the company's PAN (legacy data). True while the PAN is blank. */
  panOk: boolean;
  einvoice: { provider: string | null; username: string | null; clientId: string | null; hasPassword: boolean; hasClientSecret: boolean };
  ewayIntraStateThreshold: number | null;
};

/** One branch, with its own values only — a null field is one it takes from the organisation. */
export type BranchRow = {
  id: string;
  name: string;
  code: string;
  isHeadOffice: boolean;
  active: boolean;
  gstRegistrationId: string | null;
  gstin: string | null;
  /** The registration's state; without one, its address's (derived, never stored). */
  stateCode: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  country: string | null;
  email: string | null;
  phone: string | null;
  addressSource: "branch" | "organisation";
  bankName: string | null;
  bankAccountNumber: string | null;
  bankIfsc: string | null;
  bankBranch: string | null;
  upiId: string | null;
  invoiceTerms: string | null;
  invoiceNotes: string | null;
  hasLogo: boolean;
  hasSignature: boolean;
  logoDataUrl: string | null;
  signatureDataUrl: string | null;
  documentCount: number;
  memberCount: number;
  canIssueTaxDocuments: boolean;
};

export type BranchSettings = {
  registrations: RegistrationRow[];
  branches: BranchRow[];
  /** `registeredOffice` is the address on one line, "" before the Profile has one. */
  org: { legalName: string; pan: string | null; registeredOffice: string };
};

/** The same gate as the organisation's own settings: all of this prints on every document. */
async function requireSettingsAccess() {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "settings.manage"))) {
    return { user: null, error: "You can't change branches or GST registrations." };
  }
  return { user, error: null };
}

/** Every screen that shows a branch or a registration. */
function revalidateBranchScreens() {
  for (const path of ["/settings/branches", "/settings/organisation", "/settings/einvoicing", "/settings/eway", "/settings/numbering"]) {
    revalidatePath(path);
  }
}

/** The organisation fields these rules read — never its cipher columns. */
const ORG_SELECT = {
  legalName: true,
  pan: true,
  addressLine1: true,
  addressLine2: true,
  city: true,
  state: true,
  stateCode: true,
  pincode: true,
  country: true,
  email: true,
  phone: true,
} as const;

type OrgRow = Prisma.OrganisationSettingsGetPayload<{ select: typeof ORG_SELECT }>;

const REGISTRATION_SELECT = {
  id: true,
  gstin: true,
  stateCode: true,
  code: true,
  active: true,
  einvoiceProvider: true,
  einvoiceUsername: true,
  einvoiceClientId: true,
  ewayIntraStateThreshold: true,
} as const;

/** The branch fields that place it in a state. */
const PLACE_SELECT = { id: true, name: true, code: true, isHeadOffice: true, addressLine1: true, state: true, country: true } as const;

const isUniqueViolation = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
const isForeignKeyViolation = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003";

/** Which constraint a P2002 hit. The driver adapter reports it in varying shapes, so it is read as text. */
const mentions = (err: unknown, word: string) =>
  err instanceof Prisma.PrismaClientKnownRequestError && `${err.message} ${JSON.stringify(err.meta ?? {})}`.includes(word);

const normalisedPan = (pan: string | null | undefined) => pan?.trim().toUpperCase() || null;

const stateName = (code: string) => GST_STATE_CODES[code] ?? code;

/** Why a GSTIN can't be one of ours, or null. The pattern is the schema's; this is the rest of rule 1. */
function gstinProblem(gstin: string): string | null {
  const stateCode = gstin.slice(0, 2);
  if (!GST_STATE_CODES[stateCode] || stateCode === OTHER_COUNTRY_CODE) return `${stateCode} isn't a GST state code — check the GSTIN's first two digits.`;
  if (!hasValidGstinChecksum(gstin)) return "That GSTIN's check digit is wrong — check it against the registration certificate.";
  return null;
}

/** Rule 2: one PAN, one company. */
function panMismatch(gstinPan: string, orgPan: string) {
  return `That GSTIN belongs to PAN ${gstinPan}; this company's PAN is ${orgPan}. A different PAN is a different company — a separate workspace.`;
}

/**
 * Where a branch is, as GST sees it: its own address, or — a head office that leaves it blank — the
 * registered office, whose GST state code the Profile stores (and holds to the head office GSTIN).
 */
function placeOf(branch: { addressLine1?: string | null; state?: string | null; country?: string | null }, org: OrgRow | null) {
  const own = Boolean(branch.addressLine1?.trim());
  const from = own ? branch : org;
  const abroad = !isIndia(from?.country);
  const name = from?.state?.trim() || null;
  const stored = own ? null : org?.stateCode?.trim() || null;
  const stateCode = abroad ? null : (stored ?? stateCodeFromName(name));
  return { own, abroad, name, stateCode };
}

/** Rule 3: why this registration can't be this branch's, or null. */
function registrationRefusal(place: ReturnType<typeof placeOf>, registration: { gstin: string; stateCode: string }, subject?: string): string | null {
  if (place.abroad) return "A branch outside India can't hold a GST registration — leave its registration blank.";
  if (place.stateCode && place.stateCode !== registration.stateCode) {
    const who = subject ?? (place.own ? "a branch" : "the registered office");
    return `A GSTIN is state-specific — ${who} in ${stateName(place.stateCode)} can't use a ${stateName(registration.stateCode)} registration.`;
  }
  if (!place.stateCode && place.own) {
    return `We don't recognise the state "${place.name ?? ""}" — choose it from the list, so it can be checked against GSTIN ${registration.gstin}.`;
  }
  return null;
}

/** Documents past draft that name a registration. Its GSTIN is on them, and on the returns filed from them. */
function issuedDocumentCount(gstRegistrationId: string) {
  return db.tradeDocument.count({ where: { gstRegistrationId, status: { not: "DRAFT" } } });
}

/** "3 documents and 1 payment" — what still names a row — and how many things that is. */
function describeUses(counts: [number, string, string][]): { text: string; total: number } {
  const used = counts.filter(([n]) => n > 0);
  const parts = used.map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);
  const text = parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return { text, total: used.reduce((sum, [n]) => sum + n, 0) };
}

/** Which registrations hold a stored password and client secret — asked of the database, so no cipher is ever read here. */
async function storedSecrets(where: Prisma.GstRegistrationWhereInput = {}) {
  const [passwords, secrets] = await Promise.all([
    db.gstRegistration.findMany({ where: { AND: [where, { einvoicePasswordCipher: { not: null } }] }, select: { id: true } }),
    db.gstRegistration.findMany({ where: { AND: [where, { einvoiceClientSecretCipher: { not: null } }] }, select: { id: true } }),
  ]);
  return { password: new Set(passwords.map((r) => r.id)), secret: new Set(secrets.map((r) => r.id)) };
}

// ─── Reads ─────────────────────────────────────────────────────────────────────

/** Everything the Branches & GST registrations screen shows, or null without `settings.manage`. */
export async function listBranchesForSettings(): Promise<BranchSettings | null> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "settings.manage"))) return null;

  // A fresh workspace still has its head office to show.
  await ensureHeadOffice();
  const [org, registrations, branches, issued, secrets] = await Promise.all([
    db.organisationSettings.findUnique({ where: { id: "global" }, select: ORG_SELECT }),
    db.gstRegistration.findMany({ select: { ...REGISTRATION_SELECT, _count: { select: { branches: true } } } }),
    db.branch.findMany({
      include: {
        gstRegistration: { select: { id: true, gstin: true, stateCode: true, code: true, active: true } },
        _count: { select: { documents: true, members: true } },
      },
    }),
    db.tradeDocument.groupBy({
      by: ["gstRegistrationId"],
      where: { gstRegistrationId: { not: null }, status: { not: "DRAFT" } },
      _count: { _all: true },
    }),
    storedSecrets(),
  ]);

  const headOffice = branches.find((b) => b.isHeadOffice) ?? null;
  const orgPan = normalisedPan(org?.pan);
  const issuedBy = new Map(issued.map((row) => [row.gstRegistrationId, row._count._all]));
  const activeRegistrations = registrations.filter((r) => r.active).length;

  const registrationRows: RegistrationRow[] = registrations
    .map((r) => ({
      id: r.id,
      gstin: r.gstin,
      stateCode: r.stateCode,
      stateName: stateName(r.stateCode),
      code: r.code,
      active: r.active,
      isHeadOffice: r.id === headOffice?.gstRegistrationId,
      branchCount: r._count.branches,
      issuedDocumentCount: issuedBy.get(r.id) ?? 0,
      checksumOk: hasValidGstinChecksum(r.gstin),
      panOk: !orgPan || panOfGstin(r.gstin) === orgPan,
      einvoice: {
        provider: r.einvoiceProvider,
        username: r.einvoiceUsername,
        clientId: r.einvoiceClientId,
        hasPassword: secrets.password.has(r.id),
        hasClientSecret: secrets.secret.has(r.id),
      },
      ewayIntraStateThreshold: r.ewayIntraStateThreshold === null ? null : Number(r.ewayIntraStateThreshold),
    }))
    .sort((a, b) => Number(b.active) - Number(a.active) || Number(b.isHeadOffice) - Number(a.isHeadOffice) || a.code.localeCompare(b.code));

  const branchRows: BranchRow[] = branches
    .map((b) => {
      const identity = mergeIdentity(b, org);
      return {
        id: b.id,
        name: b.name,
        code: b.code,
        isHeadOffice: b.isHeadOffice,
        active: b.active,
        gstRegistrationId: b.gstRegistrationId,
        gstin: b.gstRegistration?.gstin ?? null,
        stateCode: identity.stateCode,
        addressLine1: b.addressLine1,
        addressLine2: b.addressLine2,
        city: b.city,
        state: b.state,
        pincode: b.pincode,
        country: b.country,
        email: b.email,
        phone: b.phone,
        addressSource: identity.addressSource,
        bankName: b.bankName,
        bankAccountNumber: b.bankAccountNumber,
        bankIfsc: b.bankIfsc,
        bankBranch: b.bankBranch,
        upiId: b.upiId,
        invoiceTerms: b.invoiceTerms,
        invoiceNotes: b.invoiceNotes,
        hasLogo: Boolean(b.logoDataUrl),
        hasSignature: Boolean(b.signatureDataUrl),
        logoDataUrl: b.logoDataUrl,
        signatureDataUrl: b.signatureDataUrl,
        documentCount: b._count.documents,
        memberCount: b._count.members,
        // As the pickers say it (listBranchChoices): an unregistered company issues as it always has.
        canIssueTaxDocuments: Boolean(b.gstRegistration?.active) || activeRegistrations === 0,
      };
    })
    .sort((a, b) => Number(b.isHeadOffice) - Number(a.isHeadOffice) || Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));

  const registeredOffice = org
    ? formatDispatchAddress({ ...org, legalName: "" }).split("\n").join(", ")
    : "";

  return {
    registrations: registrationRows,
    branches: branchRows,
    org: { legalName: org?.legalName ?? "", pan: orgPan, registeredOffice },
  };
}

/** Active branches for a client-side picker, head office first. Anybody signed in: it is what their documents print. */
export async function listBranchOptions(): Promise<BranchChoice[]> {
  await requireUser();
  return listBranchChoices();
}

// ─── GST registrations ─────────────────────────────────────────────────────────

/**
 * Adds a registration, or edits one's GSTIN or code.
 *
 * The first registration of a company whose PAN is blank sets the PAN; a head office without a
 * registration is given the new one when it is in the head office's state (or that state isn't
 * known). A second registration in one state is allowed — separate business verticals — and warned.
 */
export async function saveGstRegistration(input: unknown): Promise<ActionResult<{ id: string; warning?: string }>> {
  const { user, error } = await requireSettingsAccess();
  if (!user) return { ok: false, error: error! };

  const parsed = gstRegistrationSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { gstin, code } = parsed.data;
  const id = parsed.data.id || null;
  const stateCode = gstin.slice(0, 2);
  const pan = panOfGstin(gstin)!;

  // Resolved before any transaction: ensureHeadOffice may write.
  const [existing, org, headOffice, clash, sameState] = await Promise.all([
    id ? db.gstRegistration.findUnique({ where: { id }, select: { id: true, gstin: true, stateCode: true } }) : Promise.resolve(null),
    db.organisationSettings.findUnique({ where: { id: "global" }, select: ORG_SELECT }),
    ensureHeadOffice(),
    db.gstRegistration.findFirst({ where: { OR: [{ gstin }, { code }], ...(id ? { NOT: { id } } : {}) }, select: { gstin: true } }),
    db.gstRegistration.count({ where: { stateCode, active: true, ...(id ? { NOT: { id } } : {}) } }),
  ]);
  if (id && !existing) return { ok: false, error: "That registration no longer exists." };
  if (clash) return { ok: false, error: clash.gstin === gstin ? GSTIN_TAKEN : CODE_TAKEN };

  // Checked when a GSTIN is entered, not on every save: a legacy registration that fails either rule
  // (the screen flags it) can still have its code edited, or be deactivated.
  const gstinChanges = !existing || existing.gstin !== gstin;
  const orgPan = normalisedPan(org?.pan);
  if (gstinChanges) {
    const problem = gstinProblem(gstin);
    if (problem) return { ok: false, error: problem };
    if (orgPan && orgPan !== pan) return { ok: false, error: panMismatch(pan, orgPan) };
  }

  if (existing && existing.gstin !== gstin) {
    // Rule 5: the GSTIN is on every document issued under it, and on the returns filed from them.
    if ((await issuedDocumentCount(existing.id)) > 0) {
      return { ok: false, error: `GSTIN ${existing.gstin} has issued documents — deactivate it and add the new registration instead.` };
    }
    if (existing.stateCode !== stateCode) {
      const attached = await db.branch.findMany({ where: { gstRegistrationId: existing.id }, select: PLACE_SELECT });
      for (const branch of attached) {
        const refusal = registrationRefusal(placeOf(branch, org), { gstin, stateCode }, branchLabel(branch));
        if (refusal) return { ok: false, error: refusal };
      }
    }
  }

  const headOfficePlace = placeOf(headOffice, org);
  const attachToHeadOffice =
    !existing && !headOffice.gstRegistrationId && !headOfficePlace.abroad && (!headOfficePlace.stateCode || headOfficePlace.stateCode === stateCode);
  const isHeadOfficeRegistration = existing ? headOffice.gstRegistrationId === existing.id : attachToHeadOffice;
  const fillPan = !orgPan && gstinChanges;

  let savedId: string;
  try {
    savedId = await db.$transaction(async (tx) => {
      const row = existing
        ? await tx.gstRegistration.update({ where: { id: existing.id }, data: { gstin, stateCode, code }, select: { id: true } })
        : // Not set up until somebody enters its IRP login — never quietly the mock portal (spec §7.1).
          await tx.gstRegistration.create({ data: { gstin, stateCode, code, einvoiceProvider: null, createdById: user.id }, select: { id: true } });
      if (attachToHeadOffice) await tx.branch.update({ where: { id: headOffice.id }, data: { gstRegistrationId: row.id }, select: { id: true } });
      if (fillPan) {
        await tx.organisationSettings.upsert({ where: { id: "global" }, create: { id: "global", legalName: "", pan }, update: { pan } });
      }
      // The organisation's gstin column mirrors the head office's registration, for a rollback build.
      if (isHeadOfficeRegistration) await tx.organisationSettings.updateMany({ where: { id: "global" }, data: { gstin } });
      return row.id;
    });
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, error: mentions(err, "gstin") ? GSTIN_TAKEN : CODE_TAKEN };
    throw err;
  }

  const notes = [fillPan && `company PAN set to ${pan} from it`, attachToHeadOffice && "given to the head office"].filter(Boolean);
  await recordAudit({
    userId: user.id,
    action: existing ? "UPDATE" : "CREATE",
    entityType: "GstRegistration",
    entityId: savedId,
    entityLabel: `${existing && existing.gstin !== gstin ? `GSTIN ${existing.gstin} → ${gstin}` : `GSTIN ${gstin}`} (${code})${notes.length ? ` — ${notes.join("; ")}` : ""}`,
  });
  revalidateBranchScreens();

  const warning =
    gstinChanges && sameState > 0
      ?`There is already a registration in ${stateName(stateCode)}. Usually a company has one per state — separate business verticals are the exception.`
      : undefined;
  return { ok: true, data: warning ? { id: savedId, warning } : { id: savedId } };
}

/** Retires or restores a registration. Refused while an active branch still bills under it. */
export async function setGstRegistrationActive(id: string, active: boolean): Promise<ActionResult<null>> {
  const { user, error } = await requireSettingsAccess();
  if (!user) return { ok: false, error: error! };

  const registration = await db.gstRegistration.findUnique({ where: { id }, select: { id: true, gstin: true, active: true } });
  if (!registration) return { ok: false, error: "That registration no longer exists." };
  if (registration.active === active) return { ok: true, data: null };

  if (!active) {
    const branches = await db.branch.findMany({
      where: { gstRegistrationId: id, active: true },
      select: { name: true, code: true, isHeadOffice: true },
    });
    if (branches.length > 0) {
      return {
        ok: false,
        error: `GSTIN ${registration.gstin} is used by ${branches.map(branchLabel).join(", ")} — move ${branches.length === 1 ? "it" : "them"} to another registration, or deactivate ${branches.length === 1 ? "it" : "them"}, first.`,
      };
    }
  }

  await db.gstRegistration.update({ where: { id }, data: { active }, select: { id: true } });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "GstRegistration",
    entityId: id,
    entityLabel: `GSTIN ${registration.gstin} ${active ? "reactivated" : "deactivated"}`,
  });
  revalidateBranchScreens();
  return { ok: true, data: null };
}

/** Deletes a registration nothing names — one added by mistake. Anything else is deactivated instead. */
export async function deleteGstRegistration(id: string): Promise<ActionResult<null>> {
  const { user, error } = await requireSettingsAccess();
  if (!user) return { ok: false, error: error! };

  const registration = await db.gstRegistration.findUnique({
    where: { id },
    select: { id: true, gstin: true, _count: { select: { branches: true, documents: true, journalLines: true, documentSeries: true } } },
  });
  if (!registration) return { ok: false, error: "That registration no longer exists." };

  const counts = registration._count;
  const uses = describeUses([
    [counts.branches, "branch", "branches"],
    [counts.documents, "document", "documents"],
    [counts.journalLines, "journal line", "journal lines"],
    [counts.documentSeries, "numbering series", "numbering series"],
  ]);
  const refusal = `Deactivate it instead — ${uses.text || "something"} ${uses.total === 1 ? "names" : "name"} GSTIN ${registration.gstin}.`;
  if (uses.total > 0) return { ok: false, error: refusal };

  try {
    await db.gstRegistration.delete({ where: { id }, select: { id: true } });
  } catch (err) {
    // Named by something written since the count: the Restrict foreign keys are the backstop.
    if (isForeignKeyViolation(err)) return { ok: false, error: refusal };
    throw err;
  }

  await recordAudit({
    userId: user.id,
    action: "DELETE",
    entityType: "GstRegistration",
    entityId: id,
    entityLabel: `GSTIN ${registration.gstin}`,
  });
  revalidateBranchScreens();
  return { ok: true, data: null };
}

/**
 * One registration's IRP connection — the NIC issues API users per GSTIN (e-way bills use the same).
 * A blank provider is "not set up"; a blank password or secret keeps the stored one, because the form
 * is never sent the decrypted value.
 */
export async function saveRegistrationEInvoice(input: unknown): Promise<ActionResult<null>> {
  const { user, error } = await requireSettingsAccess();
  if (!user) return { ok: false, error: error! };

  const parsed = registrationEInvoiceSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const data = parsed.data;

  const registration = await db.gstRegistration.findUnique({ where: { id: data.gstRegistrationId }, select: { id: true, gstin: true } });
  if (!registration) return { ok: false, error: "That registration no longer exists." };

  const provider = data.provider || null;
  if (provider === "nic_sandbox" || provider === "nic_production") {
    const stored = await storedSecrets({ id: registration.id });
    const willHavePassword = data.password || stored.password.has(registration.id);
    const willHaveSecret = data.clientSecret || stored.secret.has(registration.id);
    if (!data.username || !willHavePassword || !data.clientId || !willHaveSecret) {
      return { ok: false, error: "The NIC portal needs a username, password, client ID and client secret." };
    }
  }

  await db.gstRegistration.update({
    where: { id: registration.id },
    data: {
      einvoiceProvider: provider,
      einvoiceUsername: data.username || null,
      einvoiceClientId: data.clientId || null,
      // A blank secret means "keep what's stored" — overwriting on blank would wipe working credentials
      // every time the form is saved.
      ...(data.password ? { einvoicePasswordCipher: await encryptSecret(data.password) } : {}),
      ...(data.clientSecret ? { einvoiceClientSecretCipher: await encryptSecret(data.clientSecret) } : {}),
    },
    select: { id: true },
  });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "GstRegistration",
    entityId: registration.id,
    entityLabel: `E-invoice connection for GSTIN ${registration.gstin} (${provider ?? "not set up"})`,
  });
  revalidateBranchScreens();
  return { ok: true, data: null };
}

// ─── Branches ──────────────────────────────────────────────────────────────────

/**
 * Adds or edits a branch. Only the head office may leave its address blank (it then prints the
 * registered office); a branch with a registration must be in that registration's state.
 */
export async function saveBranch(input: unknown): Promise<ActionResult<{ id: string }>> {
  const { user, error } = await requireSettingsAccess();
  if (!user) return { ok: false, error: error! };

  const parsed = branchSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const data = parsed.data;
  const id = data.id || null;
  const registrationId = data.gstRegistrationId || null;

  const [existing, registration, org, codeTaken] = await Promise.all([
    id ? db.branch.findUnique({ where: { id }, select: { id: true, isHeadOffice: true, active: true, gstRegistrationId: true } }) : Promise.resolve(null),
    registrationId
      ? db.gstRegistration.findUnique({ where: { id: registrationId }, select: { id: true, gstin: true, stateCode: true, active: true } })
      : Promise.resolve(null),
    db.organisationSettings.findUnique({ where: { id: "global" }, select: ORG_SELECT }),
    db.branch.findFirst({ where: { code: data.code, ...(id ? { NOT: { id } } : {}) }, select: { id: true } }),
  ]);
  if (id && !existing) return { ok: false, error: "That branch no longer exists." };
  if (codeTaken) return { ok: false, error: CODE_TAKEN };

  // A new branch is never the head office: the flag only moves, through setHeadOffice.
  const isHeadOffice = existing?.isHeadOffice ?? false;
  if (!isHeadOffice && !data.addressLine1) {
    return { ok: false, error: "A branch needs its own address — only the head office can use the registered office's." };
  }

  if (registrationId) {
    if (!registration) return { ok: false, error: "That GST registration no longer exists." };
    // An inactive branch may keep the retired registration it already had; nothing may take one up.
    const keepsRetired = existing && !existing.active && existing.gstRegistrationId === registration.id;
    if (!registration.active && !keepsRetired) {
      return { ok: false, error: `GSTIN ${registration.gstin} is inactive — reactivate it, or choose another registration.` };
    }
    const refusal = registrationRefusal(placeOf(data, org), registration);
    if (refusal) return { ok: false, error: refusal };
  }

  const text = (value: string | undefined) => value?.trim() || null;
  const ownAddress = Boolean(data.addressLine1);
  const fields = {
    name: data.name,
    code: data.code,
    gstRegistrationId: registrationId,
    // All or nothing (the schema's rule): a head office left blank prints the registered office.
    addressLine1: ownAddress ? text(data.addressLine1) : null,
    addressLine2: ownAddress ? text(data.addressLine2) : null,
    city: ownAddress ? text(data.city) : null,
    state: ownAddress ? text(data.state) : null,
    pincode: ownAddress ? text(data.pincode) : null,
    country: ownAddress ? text(data.country) : null,
    email: text(data.email),
    phone: text(data.phone),
    bankName: text(data.bankName),
    bankAccountNumber: text(data.bankAccountNumber),
    bankIfsc: text(data.bankIfsc)?.toUpperCase() ?? null,
    bankBranch: text(data.bankBranch),
    upiId: text(data.upiId),
    invoiceTerms: text(data.invoiceTerms),
    invoiceNotes: text(data.invoiceNotes),
  };
  // The organisation's gstin column mirrors the head office's registration, for a rollback build.
  const mirror = isHeadOffice && existing?.gstRegistrationId !== registrationId;

  let savedId: string;
  try {
    savedId = await db.$transaction(async (tx) => {
      const row = existing
        ? await tx.branch.update({ where: { id: existing.id }, data: fields, select: { id: true } })
        : await tx.branch.create({ data: { ...fields, createdById: user.id }, select: { id: true } });
      if (mirror) await tx.organisationSettings.updateMany({ where: { id: "global" }, data: { gstin: registration?.gstin ?? null } });
      return row.id;
    });
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, error: CODE_TAKEN };
    throw err;
  }

  await recordAudit({
    userId: user.id,
    action: existing ? "UPDATE" : "CREATE",
    entityType: "Branch",
    entityId: savedId,
    entityLabel: `${branchLabel({ name: data.name, code: data.code, isHeadOffice })} — ${registration ? `GSTIN ${registration.gstin}` : "no GST registration"}`,
  });
  revalidateBranchScreens();
  return { ok: true, data: { id: savedId } };
}

/**
 * Moves the head office flag. The outgoing head office, if it printed the registered office, is given
 * that address first — as an ordinary branch it needs one, and that one is what it printed.
 */
export async function setHeadOffice(id: string): Promise<ActionResult<null>> {
  const { user, error } = await requireSettingsAccess();
  if (!user) return { ok: false, error: error! };

  const [target, org] = await Promise.all([
    db.branch.findUnique({
      where: { id },
      select: { id: true, name: true, code: true, isHeadOffice: true, active: true, gstRegistration: { select: { gstin: true } } },
    }),
    db.organisationSettings.findUnique({ where: { id: "global" }, select: ORG_SELECT }),
    // Before the transaction, which reads the head office itself: ensureHeadOffice may write.
    ensureHeadOffice(),
  ]);
  if (!target) return { ok: false, error: "That branch no longer exists." };
  if (target.isHeadOffice) return { ok: true, data: null };
  if (!target.active) return { ok: false, error: `Reactivate ${branchLabel(target)} before making it the head office.` };

  let outgoingLabel: string | null;
  try {
    outgoingLabel = await db.$transaction(async (tx) => {
      // Read again here: whoever holds the flag now is who gives it up.
      const outgoing = await tx.branch.findFirst({
        where: { isHeadOffice: true },
        select: { id: true, name: true, code: true, isHeadOffice: true, addressLine1: true, email: true, phone: true },
      });
      if (outgoing && !outgoing.addressLine1?.trim() && org?.addressLine1?.trim()) {
        await tx.branch.update({
          where: { id: outgoing.id },
          data: {
            addressLine1: org.addressLine1,
            addressLine2: org.addressLine2,
            city: org.city,
            state: org.state,
            pincode: org.pincode,
            country: org.country,
            email: outgoing.email ?? org.email,
            phone: outgoing.phone ?? org.phone,
          },
          select: { id: true },
        });
      }
      // Off, then on: the partial unique index (branches_one_head_office) is checked statement by statement.
      if (outgoing) await tx.branch.update({ where: { id: outgoing.id }, data: { isHeadOffice: false }, select: { id: true } });
      await tx.branch.update({ where: { id: target.id }, data: { isHeadOffice: true }, select: { id: true } });
      // The organisation's gstin column mirrors the head office's registration, for a rollback build.
      await tx.organisationSettings.updateMany({ where: { id: "global" }, data: { gstin: target.gstRegistration?.gstin ?? null } });
      return outgoing ? branchLabel(outgoing) : null;
    });
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, error: "Somebody else changed the head office at the same moment — reload and try again." };
    throw err;
  }

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Branch",
    entityId: target.id,
    entityLabel: `${branchLabel(target)} made the head office${outgoingLabel ? ` (was ${outgoingLabel})` : ""}`,
  });
  revalidateBranchScreens();
  return { ok: true, data: null };
}

/**
 * Retires or restores a branch. A retired branch keeps its documents and drafts (a draft must be moved
 * before it is issued) and leaves the pickers; the head office can't be retired.
 */
export async function setBranchActive(id: string, active: boolean): Promise<ActionResult<null>> {
  const { user, error } = await requireSettingsAccess();
  if (!user) return { ok: false, error: error! };

  const branch = await db.branch.findUnique({
    where: { id },
    select: { id: true, name: true, code: true, isHeadOffice: true, active: true, gstRegistration: { select: { gstin: true, active: true } } },
  });
  if (!branch) return { ok: false, error: "That branch no longer exists." };
  if (branch.active === active) return { ok: true, data: null };
  if (!active && branch.isHeadOffice) {
    return { ok: false, error: "The head office can't be deactivated — make another branch the head office first." };
  }
  // An active branch never bills under a retired registration (the registration can't be retired under one).
  if (active && branch.gstRegistration && !branch.gstRegistration.active) {
    return {
      ok: false,
      error: `Its GSTIN ${branch.gstRegistration.gstin} is inactive — reactivate the registration first, or give the branch another one.`,
    };
  }

  await db.branch.update({ where: { id }, data: { active }, select: { id: true } });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Branch",
    entityId: id,
    entityLabel: `${branchLabel(branch)} ${active ? "reactivated" : "deactivated"}`,
  });
  revalidateBranchScreens();
  return { ok: true, data: null };
}

/** Deletes a branch nothing names — one added by mistake. Anything else is deactivated instead. */
export async function deleteBranch(id: string): Promise<ActionResult<null>> {
  const { user, error } = await requireSettingsAccess();
  if (!user) return { ok: false, error: error! };

  const branch = await db.branch.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      code: true,
      isHeadOffice: true,
      _count: { select: { documents: true, payments: true, consignments: true, journalLines: true, documentSeries: true, members: true } },
    },
  });
  if (!branch) return { ok: false, error: "That branch no longer exists." };
  if (branch.isHeadOffice) return { ok: false, error: "The head office can't be deleted — make another branch the head office first." };

  const counts = branch._count;
  const uses = describeUses([
    [counts.documents, "document", "documents"],
    [counts.payments, "payment", "payments"],
    [counts.consignments, "consignment", "consignments"],
    [counts.journalLines, "journal line", "journal lines"],
    [counts.documentSeries, "numbering series", "numbering series"],
    [counts.members, "team member", "team members"],
  ]);
  const refusal = `Deactivate it instead — ${uses.text || "something"} ${uses.total === 1 ? "names" : "name"} it.`;
  if (uses.total > 0) return { ok: false, error: refusal };

  try {
    await db.branch.delete({ where: { id }, select: { id: true } });
  } catch (err) {
    if (isForeignKeyViolation(err)) return { ok: false, error: refusal };
    throw err;
  }

  await recordAudit({
    userId: user.id,
    action: "DELETE",
    entityType: "Branch",
    entityId: id,
    entityLabel: branchLabel(branch),
  });
  revalidateBranchScreens();
  return { ok: true, data: null };
}

/** A branch's own logo or signature, printed on its documents instead of the organisation's. Null clears it. */
export async function setBranchImage(input: {
  branchId: string;
  kind: "logo" | "signature";
  dataUrl: string | null;
}): Promise<ActionResult<null>> {
  const { user, error } = await requireSettingsAccess();
  if (!user) return { ok: false, error: error! };

  const kind = input?.kind;
  if (kind !== "logo" && kind !== "signature") return { ok: false, error: "Choose a logo or a signature." };
  const dataUrl = input.dataUrl ?? null;
  if (dataUrl !== null) {
    // The same checks as the organisation's signature (uploadSignature in src/actions/organisation.ts).
    const match = typeof dataUrl === "string" ? /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl) : null;
    if (!match) return { ok: false, error: "Use a PNG, JPEG or WebP image." };
    // Base64 is 4 characters per 3 bytes, so the encoded length bounds the decoded size closely enough.
    if ((match[2].length * 3) / 4 > MAX_IMAGE_BYTES) return { ok: false, error: "That image is over 256KB — use a smaller one." };
  }

  const branch = await db.branch.findUnique({
    where: { id: String(input.branchId ?? "") },
    select: { id: true, name: true, code: true, isHeadOffice: true },
  });
  if (!branch) return { ok: false, error: "That branch no longer exists." };

  await db.branch.update({
    where: { id: branch.id },
    data: kind === "logo" ? { logoDataUrl: dataUrl } : { signatureDataUrl: dataUrl },
    select: { id: true },
  });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Branch",
    entityId: branch.id,
    entityLabel: `${branchLabel(branch)} — ${kind} ${dataUrl ? "updated" : "removed"}`,
  });
  revalidateBranchScreens();
  return { ok: true, data: null };
}

// ─── People ────────────────────────────────────────────────────────────────────

/**
 * Where somebody works: their default branch on new documents, and the state professional tax is
 * worked out for (spec §10). Gated like the rest of a person's assignment — `users.manage`.
 */
export async function setUserBranch(userId: string, branchId: string | null): Promise<ActionResult<null>> {
  const session = await requireUser();
  const admin = await actorContext(session.id);
  if (!(await hasEffectivePermission(admin.id, "users.manage"))) {
    return { ok: false, error: "You can't change where people work." };
  }

  const wanted = branchId || null;
  const [target, branch] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { id: true, isSuperAdmin: true, branchId: true } }),
    wanted
      ? db.branch.findUnique({ where: { id: wanted }, select: { id: true, name: true, code: true, isHeadOffice: true, active: true } })
      : Promise.resolve(null),
  ]);
  if (!target) return { ok: false, error: "That user no longer exists." };
  try {
    assertMayActOnTarget(admin, target);
  } catch (err) {
    if (err instanceof AuthzError) return { ok: false, error: err.message };
    throw err;
  }
  if (wanted && !branch) return { ok: false, error: "That branch no longer exists." };
  if (branch && !branch.active) return { ok: false, error: `${branchLabel(branch)} is inactive — choose an active branch.` };
  if (target.branchId === (branch?.id ?? null)) return { ok: true, data: null };

  await db.user.update({ where: { id: target.id }, data: { branchId: branch?.id ?? null }, select: { id: true } });
  await recordAudit({
    userId: admin.id,
    action: "UPDATE",
    entityType: "User",
    entityId: target.id,
    entityLabel: branch ? `Works at ${branchLabel(branch)}` : "Works at: not set",
  });
  revalidatePath("/settings/access");
  return { ok: true, data: null };
}

/** Everybody's "works at", for the team roster. Empty without `users.manage`. */
export async function listUserBranchAssignments(): Promise<{ userId: string; branchId: string | null }[]> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "users.manage"))) return [];
  const rows = await db.user.findMany({ select: { id: true, branchId: true } });
  return rows.map((row) => ({ userId: row.id, branchId: row.branchId }));
}
