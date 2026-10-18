import { z } from "zod";
import { appRoute } from "@/lib/app/handler";
import { needAppModule, refused } from "@/lib/app/daily";
import { setTaskStatus } from "@/actions/task";

/** Moving one of the person's tasks along from the Deskzo app: `{ status }` — the web's own setTaskStatus (owner, 18 Oct 2026). */

export const dynamic = "force-dynamic";

const body = z.object({ status: z.enum(["TODO", "IN_PROGRESS", "DONE", "CANCELLED"]) });

export const PATCH = appRoute({}, async ({ actor, params, body: read }) => {
  await needAppModule("tasks", actor.userId);
  const { status } = body.parse(await read());
  const result = await setTaskStatus(params.id ?? "", status);
  if (!result.ok) refused(result);
  return { data: { status, next_task_id: result.data.nextTaskId } };
});
