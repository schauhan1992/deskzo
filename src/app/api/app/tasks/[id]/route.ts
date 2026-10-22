import { z } from "zod";
import { appRoute } from "@/lib/app/handler";
import { needAppModule, refused } from "@/lib/app/daily";
import { setTaskStatus } from "@/actions/task";

/**
 * Moving one of the person's tasks along from the Deskzo app: `{ status, note? }` — the web's own setTaskStatus
 * (owner, 18 Oct 2026), so Need help and Cancelled ask for their note here too (owner, 22 Oct 2026).
 */

export const dynamic = "force-dynamic";

const body = z.object({ status: z.enum(["TODO", "IN_PROGRESS", "NEED_HELP", "DONE", "CANCELLED"]), note: z.string().max(5000).optional() });

export const PATCH = appRoute({}, async ({ actor, params, body: read }) => {
  await needAppModule("tasks", actor.userId);
  const { status, note } = body.parse(await read());
  const result = await setTaskStatus(params.id ?? "", status, note);
  if (!result.ok) refused(result);
  return { data: { status, next_task_id: result.data.nextTaskId } };
});
