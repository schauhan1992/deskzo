import { db } from "@/lib/db";
import { currentUser, viewAsContext } from "@/lib/session";
import { currentMaintenance, mayBypassMaintenance } from "@/lib/maintenance";
import { moduleAccessFor } from "@/lib/modules-access";
import { currentTenant, runAsTenant } from "@/lib/tenancy/resolve";
import { isListening, listeningIn, publishIn, subscribe } from "@/lib/chat/bus";
import { deliverPending, recordLastSeen } from "@/lib/chat/server";
import type { ChatEvent } from "@/lib/chat/types";

/**
 * Team chat, live: a server-sent event stream per open window, carrying new messages, ticks, typing
 * and who is online (src/lib/chat/bus.ts). The browser's EventSource reconnects by itself when it
 * drops, and the page then reloads what it shows, so nothing is lost across a gap.
 *
 * Under /api the proxy doesn't stand in front of this, so it makes the checks itself: signed in and
 * through the access gate (`currentUser`), as themselves, and chat open to them. The person is checked
 * again every minute — a switched-off or locked account loses the stream at once rather than at its
 * next page — and every stream ends after twenty minutes, so the browser's reconnect runs the full
 * sign-in check again.
 */
export const dynamic = "force-dynamic";

const RECHECK_MS = 60_000;
const HEARTBEAT_MS = 25_000;
const LIFETIME_MS = 20 * 60_000;

export async function GET(request: Request) {
  // Another site's page can't read this (no CORS), but there is no reason to let it hold one open.
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return new Response("Forbidden", { status: 403 });

  const user = await currentUser();
  if (!user) return new Response("Sign in first.", { status: 401 });
  if (await viewAsContext()) return new Response("Chat is private: switch back to your own account.", { status: 403 });
  const maintenance = await currentMaintenance();
  if (maintenance.phase === "on" && !(await mayBypassMaintenance(user.id))) return new Response("The app is down for maintenance.", { status: 503 });
  if ((await moduleAccessFor(user.id, "chat")) !== "available") return new Response("Chat isn't available to you.", { status: 403 });

  const tenant = await currentTenant();
  const encoder = new TextEncoder();
  const userId = user.id;
  let cleanup: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const write = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          close();
        }
      };
      const send = (event: ChatEvent) => write(`data: ${JSON.stringify(event)}\n\n`);

      const wasOnline = isListening(tenant.id, userId);
      const unsubscribe = subscribe(tenant.id, userId, send);
      const heartbeat = setInterval(() => write(": keep-alive\n\n"), HEARTBEAT_MS);
      const recheck = setInterval(() => {
        void runAsTenant(tenant, async () => {
          const row = await db.user.findUnique({ where: { id: userId }, select: { active: true, lockedAt: true } }).catch(() => null);
          if (!row || !row.active || row.lockedAt) close();
        });
      }, RECHECK_MS);
      const lifetime = setTimeout(() => close(), LIFETIME_MS);

      function close() {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        clearInterval(recheck);
        clearTimeout(lifetime);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Already closed by the browser going away.
        }
        // The last window closing: "last seen" now, and everyone else is told they've gone.
        if (!isListening(tenant.id, userId)) {
          const at = new Date();
          void runAsTenant(tenant, () => recordLastSeen(userId, at));
          publishIn(tenant.id, listeningIn(tenant.id), { type: "presence", userId, online: false, lastSeenAt: at.toISOString() });
        }
      }
      cleanup = close;
      request.signal.addEventListener("abort", close);

      // Retry after three seconds if the line drops; then who is online, for the screen to start from.
      write("retry: 3000\n\n");
      send({ type: "ready", online: listeningIn(tenant.id) });
      if (!wasOnline) publishIn(tenant.id, listeningIn(tenant.id).filter((id) => id !== userId), { type: "presence", userId, online: true, lastSeenAt: null });
      // Whatever was sent while they were away has now reached them.
      void runAsTenant(tenant, () => deliverPending(userId)).catch(() => {});
    },
    cancel() {
      cleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      // no-transform: a compressing proxy (or Next's own) would otherwise hold events back to fill a buffer.
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
      connection: "keep-alive",
    },
  });
}
