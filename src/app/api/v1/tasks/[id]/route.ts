import { apiRoute } from "@/lib/api/handler";
import { getTaskApi, patchTaskApi } from "@/lib/api/v1/work";

/** One task, by its id: read, or changed (src/lib/api/v1/work.ts). */

export const dynamic = "force-dynamic";

export const GET = apiRoute({ scope: "tasks:read" }, getTaskApi);
export const PATCH = apiRoute({ scope: "tasks:write" }, patchTaskApi);
