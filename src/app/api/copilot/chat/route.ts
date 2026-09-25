import { currentUser, viewAsContext } from "@/lib/session";
import { currentMaintenance, mayBypassMaintenance, maintenanceAppName } from "@/lib/maintenance";
import { CopilotRefusal, runCopilot } from "@/lib/copilot/agent";
import type { ChatEvent } from "@/lib/copilot/types";
import { requestHost } from "@/lib/tenancy/host";

/**
 * The copilot's chat, streamed: one JSON object per line (see `ChatEvent`), so the answer appears as
 * it is written. A route handler rather than a server action because an action returns one value,
 * not a stream.
 *
 * Being under /api, the proxy doesn't stand in front of this, so it makes the proxy's checks itself:
 * signed in (and through the access gate — `currentUser` applies it), not held by maintenance mode,
 * and posted by this app rather than a page on another site carrying the person's cookie.
 */
export const dynamic = "force-dynamic";

const json = (status: number, error: string) => Response.json({ error }, { status });

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  // The real host of this request (see src/lib/tenancy/host.ts) — a forwarded one is only a claim.
  const checked = requestHost(request.headers);
  const host = typeof checked === "string" ? checked : null;
  let sameOrigin = false;
  try {
    sameOrigin = !!origin && !!host && new URL(origin).host === host;
  } catch {
    sameOrigin = false;
  }
  if (!sameOrigin) return json(403, "Only this app can talk to the copilot.");

  const user = await currentUser();
  if (!user) return json(401, "Sign in first.");
  // A copilot conversation is private, and "view as" would open it as somebody else's — their
  // chats, their allowance, their name on anything drafted. Not while borrowing an account.
  if (await viewAsContext()) return json(403, "Switch back to your own account to use the copilot.");
  const maintenance = await currentMaintenance();
  if (maintenance.phase === "on" && !(await mayBypassMaintenance(user.id))) return json(503, "The app is down for maintenance.");

  let body: { conversationId?: unknown; message?: unknown };
  try {
    body = await request.json();
  } catch {
    return json(400, "That wasn't a message.");
  }
  const message = typeof body.message === "string" ? body.message : "";
  const conversationId = typeof body.conversationId === "string" && body.conversationId ? body.conversationId : null;
  const appName = await maintenanceAppName();

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: ChatEvent) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          // The reader went away; the work carries on to its end so what was spent is recorded.
        }
      };
      try {
        await runCopilot({ userId: user.id, userName: user.name, role: user.role, conversationId, text: message, appName, emit, signal: request.signal });
      } catch (err) {
        emit({ type: "error", message: err instanceof CopilotRefusal ? err.message : "Something went wrong on the server." });
        if (!(err instanceof CopilotRefusal)) console.error("copilot chat failed", err);
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed by the client.
        }
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
}
