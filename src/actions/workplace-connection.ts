"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { refuseWhileViewingAs, viewAsContext } from "@/lib/session";
import { requireModuleUser } from "@/lib/modules-access";
import { recordAudit } from "@/lib/audit";
import { removeConnection } from "@/lib/mail/store";
import { mailProviders } from "@/lib/workplace/settings";
import { MAIL_NAMES } from "@/lib/workplace/providers";
import { toPlain } from "@/lib/serialize";
import type { ActionResult } from "@/actions/company";

/**
 * My profile → Mailbox and calendar: the person's own connection to Outlook, Gmail or Zoho, which
 * documents are emailed through and the calendar is kept through. Either is reason enough to have one,
 * so either module opens it.
 */

export async function getMyConnection() {
  const user = await requireModuleUser(["sales_documents", "purchase_documents", "calendar"]);
  // Viewing as somebody shows nothing: whose mailbox is connected is theirs to see.
  if (await viewAsContext()) return null;
  const [connection, providers] = await Promise.all([
    db.mailConnection.findUnique({
      where: { userId: user.id },
      select: { provider: true, mailbox: true, displayName: true, connectedAt: true, lastUsedAt: true, brokenAt: true, lastError: true },
    }),
    mailProviders(),
  ]);
  return toPlain({ providers, connection });
}

export async function disconnectMyConnection(): Promise<ActionResult<null>> {
  const user = await requireModuleUser(["sales_documents", "purchase_documents", "calendar"]);
  const blockedWhileViewing = await refuseWhileViewingAs();
  if (blockedWhileViewing) return { ok: false, error: blockedWhileViewing };
  const had = await removeConnection(user.id);
  if (had) {
    await recordAudit({ userId: user.id, action: "DELETE", entityType: "MailConnection", entityId: user.id, entityLabel: `${MAIL_NAMES[had.provider]} disconnected: ${had.mailbox}` });
  }
  revalidatePath("/profile");
  revalidatePath("/calendar");
  return { ok: true, data: null };
}
