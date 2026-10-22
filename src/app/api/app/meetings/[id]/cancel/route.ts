import { appRoute } from "@/lib/app/handler";
import { appCancelMeeting } from "@/lib/app/field";

/** POST `{ note? }`: one of the person's meetings, cancelled — those invited are told. */

export const dynamic = "force-dynamic";

export const POST = appRoute({}, appCancelMeeting);
