import { appRoute } from "@/lib/app/handler";
import { needAppModule, refused, tasksFor } from "@/lib/app/daily";
import { createTask } from "@/actions/task";

/**
 * The person's tasks in the Deskzo app (owner, 18 Oct 2026). GET `?view=today|overdue|open|done`. POST `{ title,
 * due? }`: a quick task for themselves — the web's own createTask.
 */

export const dynamic = "force-dynamic";

export const GET = appRoute({}, async ({ actor, url }) => ({ data: await tasksFor(actor.userId, url.searchParams.get("view") ?? "open") }));

export const POST = appRoute({}, async ({ actor, body }) => {
  await needAppModule("tasks", actor.userId);
  const input = await body();
  const result = await createTask({ title: input.title, dueDate: input.due || undefined, assignedToUserId: actor.userId });
  if (!result.ok) refused(result);
  return { status: 201, data: { id: result.data.id } };
});
