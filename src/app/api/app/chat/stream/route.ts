import { appRoute, phoneStillAllowed } from "@/lib/app/handler";
import { needAppModule } from "@/lib/app/daily";
import { normaliseIp } from "@/lib/access/ip";
import { clientIpFrom } from "@/lib/client-ip";
import { moduleAccessFor } from "@/lib/modules-access";
import { currentTenant, runAsTenant } from "@/lib/tenancy/resolve";
import { isListening, listeningIn, publishIn, subscribe } from "@/lib/chat/bus";
import { deliverPending, recordLastSeen } from "@/lib/chat/server";
import type { ChatEvent } from "@/lib/chat/types";

/**
 * Team chat, live, for the Deskzo app: the same server-sent events the website's chat gets (src/app/api/chat/stream) —
 * new messages, ticks, typing, who is online — signed in by the phone. The phone and its person are checked again every
 * minute — revoked, signed out, locked, outside their rules, or Chat closed to them ends it at once (security review,
 * 23 Oct 2026) — and the stream ends after twenty, so the app's reconnect runs every check again.
 */

export const dynamic = "force-dynamic";

const RECHECK_MS = 60_000;
const HEARTBEAT_MS = 25_000;
const LIFETIME_MS = 20 * 60_000;

export const GET = appRoute({}, async ({ actor, req, device }) => {
  await needAppModule("chat", actor.userId);
  const ip = normaliseIp(clientIpFrom(req.headers));
  const tenant = await currentTenant();
  const encoder = new TextEncoder();
  const userId = actor.userId;
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
          const allowed = (await phoneStillAllowed(device.id, ip).catch(() => false)) && (await moduleAccessFor(userId, "chat").catch(() => null)) === "available";
          if (!allowed) close();
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
          // Already closed by the phone going away.
        }
        // The last window or phone closing: "last seen" now, and everyone else is told.
        if (!isListening(tenant.id, userId)) {
          const at = new Date();
          void runAsTenant(tenant, () => recordLastSeen(userId, at));
          publishIn(tenant.id, listeningIn(tenant.id), { type: "presence", userId, online: false, lastSeenAt: at.toISOString() });
        }
      }
      cleanup = close;
      req.signal.addEventListener("abort", close);

      write("retry: 3000\n\n");
      send({ type: "ready", online: listeningIn(tenant.id) });
      if (!wasOnline) publishIn(tenant.id, listeningIn(tenant.id).filter((id) => id !== userId), { type: "presence", userId, online: true, lastSeenAt: null });
      // Whatever was sent while they were away has now reached them: grey ticks for the senders.
      void runAsTenant(tenant, () => deliverPending(userId)).catch(() => {});
    },
    cancel() {
      cleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
      connection: "keep-alive",
    },
  });
});
