import { appRoute } from "@/lib/app/handler";
import { requestExceptionFromPhone } from "@/lib/app/daily";

/**
 * Asking, from the Deskzo app, to clock in or out away from the office today (owner, 22 Oct 2026):
 * `{ action: "in" | "out", reason_code, reason, latitude?, longitude?, accuracy?, mocked? }`. Waits for an approver
 * (src/actions/attendance-exceptions.ts); the person is told when it is decided, and the Today screen shows it.
 */

export const dynamic = "force-dynamic";

export const POST = appRoute({}, async ({ body: read, actor }) => {
  const input = await read();
  return { data: await requestExceptionFromPhone(actor.userId, input) };
});
