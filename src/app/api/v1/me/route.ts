import { apiRoute } from "@/lib/api/handler";

/**
 * The public API's "who am I": the key's name and scopes, and the person it acts as — a key works
 * when this answers (src/lib/api). Any live key may ask.
 */

export const dynamic = "force-dynamic";

export const GET = apiRoute({ scope: null }, async ({ actor }) => ({
  data: { key: { id: actor.keyId, name: actor.keyName, scopes: actor.scopes }, person: { id: actor.userId, name: actor.name, email: actor.email, role: actor.role } },
}));
