"use server";

import { revalidatePath } from "next/cache";
import type { TradeDocumentType } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { tradeDocumentLabels, tradeDocumentTypeValues } from "@/lib/trade-documents";
import {
  approvalRequirement,
  defaultApprovalPolicy,
  mayApprove,
  maySubmit,
  type ApprovalPolicy,
} from "@/lib/documents/approval";
import { approvalDocumentFor, approvalPolicyFor } from "@/lib/documents/approval-policy";
import type { ActionResult } from "@/actions/company";

/**
 * Submitting a document for sign-off, and signing it off.
 *
 * The rules live in `src/lib/documents/approval.ts` so they can be checked without a database; this
 * is the part that reads the policy, walks the reporting line, writes the outcome and tells the
 * people who need to know.
 */

/** The reporting line above someone, nearest first. */
async function managerChain(userId: string | null, depth = 6): Promise<string[]> {
  if (!userId) return [];
  const chain: string[] = [];
  let current = userId;
  for (let i = 0; i < depth; i += 1) {
    const row = await db.user.findUnique({ where: { id: current }, select: { managerId: true } });
    const next = row?.managerId;
    // Stops on a cycle as well as on the top of the tree: "reports to" is editable data, and two
    // people pointing at each other would otherwise spin here until the request timed out.
    if (!next || chain.includes(next)) break;
    chain.push(next);
    current = next;
  }
  return chain;
}

/** Every policy, including the types nobody has configured — the settings screen lists them all. */
export async function listApprovalPolicies(): Promise<
  ActionResult<
    (ApprovalPolicy & { approvers: { id: string; name: string }[]; updatedAt: Date | null; updatedBy: string | null })[]
  >
> {
  const user = await requireUser();
  if (!(await can(user.id, "settings.manage"))) return { ok: false, error: "You can't change these settings." };

  const rows = await db.documentApprovalPolicy.findMany({
    select: {
      docType: true, enabled: true, approverRoles: true, managerApproves: true, updatedAt: true,
      minValue: true, maxDiscountPercent: true,
      approvers: { select: { id: true, name: true }, orderBy: { name: "asc" } },
      updatedBy: { select: { name: true } },
    },
  });
  const byType = new Map(rows.map((r) => [r.docType, r]));

  return {
    ok: true,
    data: tradeDocumentTypeValues.map((docType) => {
      const row = byType.get(docType);
      return {
        ...(row
          ? {
              docType,
              enabled: row.enabled,
              approverRoles: row.approverRoles,
              approverUserIds: row.approvers.map((a) => a.id),
              managerApproves: row.managerApproves,
              minValue: row.minValue === null ? null : Number(row.minValue),
              maxDiscountPercent: row.maxDiscountPercent === null ? null : Number(row.maxDiscountPercent),
            }
          : defaultApprovalPolicy(docType)),
        approvers: row?.approvers ?? [],
        updatedAt: row?.updatedAt ?? null,
        updatedBy: row?.updatedBy?.name ?? null,
      };
    }),
  };
}

export async function saveApprovalPolicy(input: {
  docType: TradeDocumentType;
  enabled: boolean;
  approverRoles: string[];
  approverUserIds: string[];
  managerApproves: boolean;
  /** Needs approval only above this many rupees. Null or left out: no value rule. */
  minValue?: number | null;
  /** Also needs approval when any line is discounted by more than this percent. Null or left out: no rule. */
  maxDiscountPercent?: number | null;
}): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (!(await can(user.id, "settings.manage"))) return { ok: false, error: "You can't change these settings." };

  if (!(tradeDocumentTypeValues as readonly string[]).includes(input.docType)) {
    return { ok: false, error: "That isn't a document type approval applies to." };
  }

  const minValue = input.minValue ?? null;
  const maxDiscountPercent = input.maxDiscountPercent ?? null;
  if (minValue !== null && !(Number.isFinite(minValue) && minValue >= 0 && minValue < 1e12)) {
    return { ok: false, error: "The value limit has to be an amount of zero or more." };
  }
  if (maxDiscountPercent !== null && !(Number.isFinite(maxDiscountPercent) && maxDiscountPercent >= 0 && maxDiscountPercent <= 100)) {
    return { ok: false, error: "The discount limit has to be a percentage between 0 and 100." };
  }

  const roles = [...new Set(input.approverRoles)];
  const userIds = [...new Set(input.approverUserIds)];

  // Both lists are validated against what exists, so a policy cannot name a role or a person that
  // was deleted between the screen loading and Save being pressed.
  if (roles.length > 0) {
    const known = await db.role.findMany({ where: { key: { in: roles } }, select: { key: true } });
    const missing = roles.filter((r) => !known.some((k) => k.key === r));
    if (missing.length > 0) return { ok: false, error: `No such role: ${missing.join(", ")}.` };
  }
  if (userIds.length > 0) {
    const known = await db.user.findMany({ where: { id: { in: userIds }, active: true }, select: { id: true } });
    if (known.length !== userIds.length) {
      return { ok: false, error: "One of those people no longer has an active account." };
    }
  }

  /**
   * Switching approval on with nobody able to approve would stop every document of that type dead.
   *
   * Refused here rather than discovered by whoever raises the next invoice. `managerApproves` counts
   * as an answer on its own — it names a different person per document rather than a fixed list.
   */
  if (input.enabled && roles.length === 0 && userIds.length === 0 && !input.managerApproves) {
    return {
      ok: false,
      error: `Nobody could approve a ${tradeDocumentLabels[input.docType].toLowerCase()}. Name a role, a person, or let the submitter's manager approve.`,
    };
  }

  await db.documentApprovalPolicy.upsert({
    where: { docType: input.docType },
    create: {
      docType: input.docType,
      enabled: input.enabled,
      approverRoles: roles,
      managerApproves: input.managerApproves,
      minValue,
      maxDiscountPercent,
      approvers: { connect: userIds.map((id) => ({ id })) },
      updatedById: user.id,
    },
    update: {
      enabled: input.enabled,
      approverRoles: roles,
      managerApproves: input.managerApproves,
      minValue,
      maxDiscountPercent,
      approvers: { set: userIds.map((id) => ({ id })) },
      updatedById: user.id,
    },
  });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "DocumentApprovalPolicy",
    entityId: input.docType,
    entityLabel: input.enabled
      ? `${user.name} switched approval on for ${tradeDocumentLabels[input.docType].toLowerCase()}s — ${[
          roles.length > 0 ? `roles ${roles.join(", ")}` : null,
          userIds.length > 0 ? `${userIds.length} named approver(s)` : null,
          input.managerApproves ? "the submitter's manager" : null,
          minValue !== null ? `only above ₹${minValue.toLocaleString("en-IN")}` : null,
          maxDiscountPercent !== null ? `or any line discounted over ${maxDiscountPercent}%` : null,
        ]
          .filter(Boolean)
          .join("; ")}`
      : `${user.name} switched approval off for ${tradeDocumentLabels[input.docType].toLowerCase()}s`,
  });

  revalidatePath("/settings/approvals");
  revalidatePath("/documents", "layout");
  return { ok: true, data: null };
}

/** The document, plus everything needed to decide who may act on it. */
async function loadForApproval(id: string, userId: string) {
  const document = await db.tradeDocument.findUnique({
    where: { id },
    select: {
      id: true, docNumber: true, docType: true, status: true, approvalStatus: true,
      submittedById: true, createdById: true, total: true, currency: true,
      company: { select: { name: true, ownerUserId: true } },
    },
  });
  if (!document) return null;
  if (!(await canSeeCompany(userId, document.company.ownerUserId))) return null;
  return document;
}

export async function submitForApproval(input: { id: string }): Promise<ActionResult<null>> {
  const user = await requireUser();
  const document = await loadForApproval(input.id, user.id);
  if (!document) return { ok: false, error: "That document no longer exists." };

  const [policy, facts] = await Promise.all([approvalPolicyFor(document.docType), approvalDocumentFor(document.id)]);
  const gate = maySubmit({
    policy,
    approvalStatus: document.approvalStatus,
    isDraft: document.status === "DRAFT",
    document: facts ?? undefined,
  });
  if (!gate.may) return { ok: false, error: gate.why ?? "It can't be submitted." };

  await db.tradeDocument.update({
    where: { id: document.id },
    data: {
      approvalStatus: "PENDING",
      submittedById: user.id,
      submittedAt: new Date(),
      // Cleared on submission: a note explaining why it was sent back reads as the current state
      // otherwise, sitting under a request that has since been answered.
      approvalNote: null,
      approvedById: null,
      approvedAt: null,
    },
  });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "TradeDocument",
    entityId: document.id,
    entityLabel: `${user.name} submitted ${document.docNumber} for approval`,
  });

  /**
   * Telling the people who can actually act on it.
   *
   * Everyone the policy names, minus the submitter — who cannot approve their own and does not need
   * telling about their own action.
   */
  for (const approverId of await approverIdsFor(policy, user.id)) {
    await notifyUser({
      userId: approverId,
      type: "DOCUMENT_APPROVAL_REQUESTED",
      title: `${tradeDocumentLabels[document.docType]} awaiting your approval`,
      message: `${user.name} submitted ${document.docNumber} for ${document.company.name}.`,
      link: `/documents/${document.id}`,
    });
  }

  revalidatePath(`/documents/${document.id}`);
  return { ok: true, data: null };
}

/** Everyone a policy allows to approve, resolved to user ids. */
async function approverIdsFor(policy: ApprovalPolicy, submitterId: string): Promise<string[]> {
  const ids = new Set(policy.approverUserIds);

  if (policy.approverRoles.length > 0) {
    const holders = await db.user.findMany({
      where: { role: { in: policy.approverRoles }, active: true },
      select: { id: true },
    });
    for (const h of holders) ids.add(h.id);
  }
  if (policy.managerApproves) {
    // The immediate manager only, for the notification — the whole chain may approve, but telling
    // four levels of management about one quotation is how people learn to ignore notifications.
    const submitter = await db.user.findUnique({ where: { id: submitterId }, select: { managerId: true } });
    if (submitter?.managerId) ids.add(submitter.managerId);
  }

  ids.delete(submitterId);
  return [...ids];
}

export async function decideApproval(input: {
  id: string;
  approved: boolean;
  note?: string;
}): Promise<ActionResult<null>> {
  const user = await requireUser();
  const document = await loadForApproval(input.id, user.id);
  if (!document) return { ok: false, error: "That document no longer exists." };

  if (document.approvalStatus !== "PENDING") {
    return { ok: false, error: "This isn't waiting for approval." };
  }

  const policy = await approvalPolicyFor(document.docType);
  const actor = await db.user.findUnique({
    where: { id: user.id },
    select: { id: true, role: true, isSuperAdmin: true },
  });
  if (!actor) return { ok: false, error: "That account no longer exists." };

  const verdict = mayApprove({
    policy,
    actor,
    subject: { submittedById: document.submittedById, submitterManagerIds: await managerChain(document.submittedById) },
  });
  if (!verdict.may) {
    return {
      ok: false,
      error:
        verdict.reason === "own-document"
          ? "You can't approve a document you submitted yourself."
          : verdict.reason === "approval-not-enabled"
            ? "This kind of document doesn't need approval."
            : "You're not an approver for this kind of document.",
    };
  }

  const note = input.note?.trim() || null;
  if (!input.approved && !note) {
    return { ok: false, error: "Say why you're sending it back — that's the part the sender needs." };
  }

  await db.tradeDocument.update({
    where: { id: document.id },
    data: {
      approvalStatus: input.approved ? "APPROVED" : "REJECTED",
      approvedById: user.id,
      approvedAt: new Date(),
      approvalNote: note,
    },
  });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "TradeDocument",
    entityId: document.id,
    entityLabel:
      `${user.name} ${input.approved ? "approved" : "sent back"} ${document.docNumber}${note ? ` — ${note}` : ""}` +
      (verdict.reason === "super-admin-own"
        ? " — their own document, as a super admin"
        : ` (as ${verdict.reason})`),
  });

  if (document.submittedById && document.submittedById !== user.id) {
    await notifyUser({
      userId: document.submittedById,
      type: "DOCUMENT_APPROVAL_DECIDED",
      title: input.approved ? `${document.docNumber} approved` : `${document.docNumber} sent back`,
      message: input.approved
        ? `${user.name} approved it. It can be issued now.`
        : `${user.name} sent it back: ${note}`,
      link: `/documents/${document.id}`,
    });
  }

  revalidatePath(`/documents/${document.id}`);
  return { ok: true, data: null };
}

/** What the document screen needs to know to draw its buttons. */
export async function approvalContext(id: string): Promise<{
  enabled: boolean;
  /** Whether this document, as it stands, needs sign-off — the type may need it only above a limit. */
  required: boolean;
  /** Why, or why not, in words for the screen. */
  why: string;
  mayApprove: boolean;
  maySubmit: boolean;
} | null> {
  const user = await requireUser();
  const document = await loadForApproval(id, user.id);
  if (!document) return null;

  const [policy, facts] = await Promise.all([approvalPolicyFor(document.docType), approvalDocumentFor(document.id)]);
  const actor = await db.user.findUnique({
    where: { id: user.id },
    select: { id: true, role: true, isSuperAdmin: true },
  });
  if (!actor || !facts) return null;
  const requirement = approvalRequirement(policy, facts);

  return {
    enabled: policy.enabled,
    required: requirement.required,
    why: requirement.why,
    mayApprove:
      document.approvalStatus === "PENDING" &&
      mayApprove({
        policy,
        actor,
        subject: {
          submittedById: document.submittedById,
          submitterManagerIds: await managerChain(document.submittedById),
        },
      }).may,
    maySubmit: maySubmit({ policy, approvalStatus: document.approvalStatus, isDraft: document.status === "DRAFT", document: facts }).may,
  };
}
