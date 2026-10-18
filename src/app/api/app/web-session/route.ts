import { appRoute } from "@/lib/app/handler";
import { openWebPages } from "@/lib/app/web-session";

/**
 * Opening Deskzo's own pages inside the app (owner, 18 Oct 2026): `{ path? }` for what the app should POST to
 * /api/app/web-open in its page view — the phone's device cookie, a one-time pass (none for somebody with
 * two-factor, who signs in there once) and where to land (src/lib/app/web-session.ts).
 */

export const dynamic = "force-dynamic";

export const POST = appRoute({}, async ({ body, device, actor }) => {
  const input = await body();
  const open = await openWebPages(device, actor.userId, input.path);
  return {
    data: {
      open: { path: "/api/app/web-open", form: { d: open.deviceToken, t: open.ticket ?? "", n: open.next } },
      sign_in: open.ticket === null,
    },
  };
});
