"use server";

import type { StaffRole } from "@deskzo/control-client";
import type { ConsoleResult } from "@/actions/platform/console";
import { OWNERS, consoleAudit, consoleRefusal, revalidateConsole } from "@/lib/platform/console-guard";
import { deliverMail } from "@/lib/platform/mailer";
import { MAIL_STREAMS, type MailType } from "@/lib/console-shared/mail-catalogue";
import { recordTest, removeConnection, saveConnection, saveRoutes } from "@/lib/platform/mail/store";
import { controlDb } from "@/lib/platform/control-db";
import { ConsoleRefused } from "@/lib/platform/refused";
import { StaffRefused, requireStaff, type Staff } from "@/lib/platform/staff-session";

/**
 * Settings › Mail (src/lib/platform/mail): the accounts the platform's mail goes through and which
 * one each type uses. Owners only, like every platform setting — an account's secret sends mail as
 * the company. Every change is in the platform audit log, by field name; a secret never is.
 *
 *   consoleSaveMailConnection     add an account, or change one (a blank secret keeps the saved one)
 *   consoleRemoveMailConnection   its types fall back to the default
 *   consoleSaveMailRoutes         every type's account, From and Reply-To, at once
 *   consoleSendTestMail           to the owner's own address: through one account, or as one type goes
 */

async function asStaff<T>(roles: readonly StaffRole[], work: (staff: Staff) => Promise<T>): Promise<ConsoleResult<T>> {
  let staff: Staff;
  try {
    staff = await requireStaff(roles);
  } catch (err) {
    if (err instanceof StaffRefused) return { ok: false, error: err.message };
    throw err;
  }
  try {
    return { ok: true, data: await work(staff) };
  } catch (err) {
    const refusal = consoleRefusal(err);
    if (refusal !== null) return { ok: false, error: refusal };
    throw err;
  }
}

export async function consoleSaveMailConnection(input: unknown): Promise<ConsoleResult<{ id: string; created: boolean }>> {
  return asStaff(OWNERS, async (staff) => {
    const saved = await saveConnection(input, staff.id);
    if (saved.created) await consoleAudit(staff, "mail.account.add", { name: saved.name, provider: saved.provider });
    else if (saved.changed.length) await consoleAudit(staff, "mail.account.change", { name: saved.name, provider: saved.provider, changed: saved.changed });
    revalidateConsole();
    return { id: saved.id, created: saved.created };
  });
}

export async function consoleRemoveMailConnection(id: unknown): Promise<ConsoleResult> {
  return asStaff(OWNERS, async (staff) => {
    const removed = await removeConnection(id);
    await consoleAudit(staff, "mail.account.remove", { name: removed.name, provider: removed.provider, streams: removed.streams });
    revalidateConsole();
    return null;
  });
}

export async function consoleSaveMailRoutes(routes: unknown): Promise<ConsoleResult<{ changed: string[] }>> {
  return asStaff(OWNERS, async (staff) => {
    const changed = await saveRoutes(routes, staff.id);
    if (changed.length) await consoleAudit(staff, "mail.routes", { changed });
    revalidateConsole();
    return { changed };
  });
}

/**
 * A test mail to the owner's own address — through one account (`connectionId`, its own From; the
 * result kept on the account), or as one type of mail goes now (`stream`). Logged like any mail, and
 * marked as a test. A refusal from the server is the answer, not an error: it says what to fix.
 */
export async function consoleSendTestMail(input: { connectionId?: unknown; stream?: unknown }): Promise<ConsoleResult<{ ok: boolean; via: string; to: string; error: string | null }>> {
  return asStaff(OWNERS, async (staff) => {
    const connectionId = typeof input?.connectionId === "string" && input.connectionId ? input.connectionId : null;
    const stream = MAIL_STREAMS.find((s) => s.key === input?.stream && s.key !== "DEFAULT")?.key as MailType | undefined;
    if (!connectionId && !stream) throw new ConsoleRefused("Choose an account or a type of mail to test.");
    const what = connectionId ? "this account" : `${MAIL_STREAMS.find((s) => s.key === stream)!.label} mail`;
    const mail = {
      type: stream ?? ("ACCOUNT" as const),
      to: staff.email,
      subject: "Test mail from the Deskzo console",
      text: [`Hello ${staff.name},`, "", `This is a test of ${what}, sent from Settings › Mail in the console.`, "", "If it arrived, the account works. Nothing to do."].join("\n"),
    };
    let result: { ok: boolean; via: string; error: string | null };
    try {
      const sent = await deliverMail(mail, { connectionId: connectionId ?? undefined, test: true });
      result = { ok: true, via: sent.via, error: null };
    } catch (err) {
      if (err instanceof ConsoleRefused) throw err;
      // The reason as the Mail log has just recorded it — secrets masked there once, the same here.
      const logged = await controlDb().mailDelivery.findFirst({ where: { test: true, status: "FAILED", toAddresses: { has: staff.email } }, orderBy: { at: "desc" }, select: { error: true } });
      result = { ok: false, via: "", error: logged?.error ?? "The mail server refused it." };
    }
    if (connectionId) await recordTest(connectionId, result.ok, result.error);
    await consoleAudit(staff, "mail.test", { target: connectionId ? "account" : stream, ok: result.ok });
    revalidateConsole();
    return { ...result, to: staff.email };
  });
}
