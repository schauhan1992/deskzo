import { logActivity, alertAdmins } from "@/lib/activity";
import { getSecurityPolicy } from "@/lib/security/store";
import { isBulkRead } from "@/lib/security/policy";
import { tenantKey } from "@/lib/tenancy/cache";
import { throttle } from "@/lib/security/throttle";

/**
 * How much customer data somebody has pulled in the last few minutes.
 *
 * This is the only measure in the module that a browser extension, a headless driver or a copied
 * session cookie cannot get around, and the reason is not clever: whatever is collecting the data
 * has to ask the server for it. An extension quietly walking every company page produces the read
 * volume of a person opening a thousand records in ten minutes. Nothing on the client can hide
 * that, because the client is what generated it.
 *
 * It does not block. A genuine month-end reconciliation, a data-quality sweep or a migration all
 * look exactly like this, and stopping the accounts team on the last day of the quarter is a worse
 * outcome than the leak it might have been. It raises a CRITICAL row and tells the admins, which
 * is the honest response to "this might be nothing".
 *
 * ## The limitation, stated plainly
 *
 * The counter is per process and in memory. One container is exact; several behind a load balancer
 * each count their own share, so the threshold effectively rises with the instance count and a
 * restart forgets the window. Making it exact means a shared counter on the path of every list
 * query, which is a real cost for a signal that is meant to prompt a question rather than trigger
 * an automatic action. If this app is ever scaled out, move `windows` to Redis and nothing else
 * here has to change.
 */

type Window = { count: number; startedAt: number };

const windows = new Map<string, Window>();
const MAX_TRACKED = 10_000;

/**
 * Adds to the running count and returns it. Exported for the check script, which needs to drive
 * the window without a database.
 */
export function noteReads(userId: string, count: number, windowMs: number, now: number = Date.now()): number {
  const existing = windows.get(userId);

  if (!existing || now - existing.startedAt >= windowMs) {
    if (windows.size >= MAX_TRACKED) {
      const oldest = windows.keys().next().value;
      if (oldest !== undefined) windows.delete(oldest);
    }
    windows.set(userId, { count, startedAt: now });
    return count;
  }

  existing.count += count;
  return existing.count;
}

export function resetBulkRead() {
  windows.clear();
}

/**
 * Call after returning a page of records that contain customer data.
 *
 * Deliberately cheap and fire-and-forget at the call site: it is a map increment in the common
 * case, and only touches the database on the crossing itself.
 */
export async function noteRecordsRead(input: {
  userId: string;
  userName: string;
  count: number;
  what: string;
  path?: string;
}) {
  if (input.count <= 0) return;

  try {
    const policy = await getSecurityPolicy();
    if (policy.bulkReadThreshold <= 0) return;

    const windowMs = policy.bulkReadWindowMinutes * 60_000;
    // Counted per workspace and person — user ids alone repeat across workspaces restored from one backup.
    const total = noteReads(`${await tenantKey()}|${input.userId}`, input.count, windowMs);
    if (!isBulkRead(total, policy)) return;

    // Once over the line the window keeps filling, so without this every subsequent page would
    // raise another critical row and another notification. One per user per window is the signal;
    // the rest is noise that gets the alerting muted.
    const { write } = throttle(`${await tenantKey()}|bulk:${input.userId}`, windowMs);
    if (!write) return;

    await logActivity({
      kind: "BULK_READ",
      severity: "CRITICAL",
      summary: `${input.userName} read ${total.toLocaleString("en-IN")} records in ${policy.bulkReadWindowMinutes} minutes (threshold ${policy.bulkReadThreshold.toLocaleString("en-IN")}) — most recently ${input.what}`,
      path: input.path,
      userId: input.userId,
      userName: input.userName,
      metadata: {
        recordsInWindow: total,
        threshold: policy.bulkReadThreshold,
        windowMinutes: policy.bulkReadWindowMinutes,
        mostRecently: input.what,
      },
    });

    await alertAdmins({
      title: "Unusual read volume",
      message: `${input.userName} has read ${total.toLocaleString("en-IN")} records in the last ${policy.bulkReadWindowMinutes} minutes, against a threshold of ${policy.bulkReadThreshold.toLocaleString("en-IN")}. This is often legitimate — a reconciliation or a data clean-up looks the same. Worth asking.`,
      link: "/activity?kind=BULK_READ",
    });
  } catch (err) {
    console.error("noteRecordsRead failed", err);
  }
}
