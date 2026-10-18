import { z } from "zod";
import { appRoute } from "@/lib/app/handler";
import { APPROVAL_KINDS, decideFromPhone } from "@/lib/app/daily";
import { ApiError } from "@/lib/api/handler";

/**
 * One decision from the Deskzo app: `{ approve, note? }` for an item of the approvals list — decided by the action
 * that owns its kind, with that kind's rules on who may (owner, 18 Oct 2026).
 */

export const dynamic = "force-dynamic";

const body = z.object({ approve: z.boolean(), note: z.string().trim().max(300).nullable().optional() });

export const POST = appRoute({}, async ({ params, body: read }) => {
  const kind = APPROVAL_KINDS.find((k) => k === params.kind);
  if (!kind) throw new ApiError(404, "not_found", "There is nothing of that kind to decide.");
  const input = body.parse(await read());
  await decideFromPhone(kind, params.id ?? "", input.approve, input.note ?? null);
  return { data: { decided: input.approve ? "approved" : "rejected" } };
});
