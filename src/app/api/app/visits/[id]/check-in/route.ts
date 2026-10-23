import { appRoute } from "@/lib/app/handler";
import { appCheckIn } from "@/lib/app/field";

/** POST `{ latitude?, longitude?, accuracy?, mocked? }`: arrived at the visit — and where the phone was. */

export const dynamic = "force-dynamic";

export const POST = appRoute({}, appCheckIn);
