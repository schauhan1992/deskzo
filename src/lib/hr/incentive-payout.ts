import { db } from "@/lib/db";

/**
 * Marking incentive earnings as gone out on a payslip.
 *
 * This lives in `src/lib/` and **not** in `src/actions/incentive.ts`, and the reason is the whole
 * point of the file.
 *
 * Every export from a `"use server"` module is a client-callable endpoint. This function previously
 * sat in one with no `requireUser()` at all — so any signed-in user could mark any incentive
 * earning PAID against any payslip id, bypassing `incentives.approve`, the permission whose own
 * description says nobody may decide their own. Worse, because it never resolved a session, a
 * server-action POST aimed at one of the public route prefixes (`/review`, `/forms`, `/track` — see
 * `PUBLIC_PREFIXES` in src/proxy.ts) reached it with no account at all.
 *
 * The guard was on the caller: `runPayroll` checks `payroll.manage` and then calls this. That is
 * the classic shape of the bug — a helper written for one trusted caller, exported from a module
 * where "exported" silently means "published". Moving it here makes the callable surface match the
 * intent, which is a stronger fix than adding a check, because it cannot be reintroduced by
 * somebody re-exporting it later.
 */
export async function attachToPayslips(pairs: { earningId: string; payslipId: string }[]) {
  for (const pair of pairs) {
    await db.incentiveEarning.update({
      where: { id: pair.earningId },
      data: { status: "PAID", paidAt: new Date(), payslipId: pair.payslipId },
    });
  }
}
