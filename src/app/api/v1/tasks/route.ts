import { apiRoute } from "@/lib/api/handler";
import { listTasksApi, createTaskApi } from "@/lib/api/v1/work";

/** Tasks the key's person reaches: listed, and added (src/lib/api/v1/work.ts). */

export const dynamic = "force-dynamic";

export const GET = apiRoute({ scope: "tasks:read" }, listTasksApi);
export const POST = apiRoute({ scope: "tasks:write" }, createTaskApi);
