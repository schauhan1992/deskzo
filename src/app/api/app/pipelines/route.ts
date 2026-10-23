import { appRoute } from "@/lib/app/handler";
import { appPipelines } from "@/lib/app/sales";

/** The pipelines and their stages, a lead's sources and the kinds of activity — what the app's lead screens offer. */

export const dynamic = "force-dynamic";

export const GET = appRoute({}, appPipelines);
