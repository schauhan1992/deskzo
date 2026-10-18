import { appRoute } from "@/lib/app/handler";
import { needAppModule, refused } from "@/lib/app/daily";
import { addTaskComment } from "@/actions/task-extras";

/** A comment on a task from the Deskzo app: `{ body }` — the web's own addTaskComment (owner, 18 Oct 2026). */

export const dynamic = "force-dynamic";

export const POST = appRoute({}, async ({ actor, params, body }) => {
  await needAppModule("tasks", actor.userId);
  const input = await body();
  const result = await addTaskComment(params.id ?? "", String(input.body ?? ""));
  if (!result.ok) refused(result);
  return { status: 201, data: { id: result.data.id } };
});
