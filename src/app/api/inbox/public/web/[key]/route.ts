import { NextResponse, type NextRequest } from "next/server";
import { restoreInProgressFor } from "@/lib/backup/maintenance";
import { clientIpFrom } from "@/lib/client-ip";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { siteAllowance } from "@/lib/platform/find-workspaces";
import { receiveWebMessage, webChannel, webMessages, webPresence } from "@/lib/inbox/server";
import { INBOX_LIMITS, channelSettings, withinHours } from "@/lib/inbox/settings";
import { workspaceClock } from "@/lib/time/workspace";
import { TenantHostMismatch, TenantNotFound, TenantNotResolved, currentTenant } from "@/lib/tenancy/resolve";

/**
 * A website's chat bubble talking to the Customer inbox (src/lib/inbox/widget-script.ts): POST, from any
 * site the channel allows, with a text/plain JSON body so no preflight is needed.
 *
 *   { op: "config" }                          the bubble's title, colour, corner and greeting
 *   { op: "send", token?, text, page? }       a visitor's message — a new conversation without a token
 *   { op: "poll", token, after? }             what was said since
 *
 * No session: the visitor's token — kept by their browser, its digest by us — is their credential, and
 * says nothing about anybody else's conversation. Limited by address and by channel, small bodies only,
 * and outside the proxy (src/proxy.ts matcher), so the workspace is found from the host here.
 */

export const dynamic = "force-dynamic";

const BODY_LIMIT = 8 * 1024;
const TEN_MINUTES = 10 * 60_000;

function cors(origin: string | null): Record<string, string> {
  return { "access-control-allow-origin": origin ?? "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type", vary: "origin", "cache-control": "no-store" };
}

const answer = (body: Record<string, unknown>, status: number, origin: string | null) => NextResponse.json(body, { status, headers: cors(origin) });

export function OPTIONS(req: NextRequest) {
  return new Response(null, { status: 204, headers: { ...cors(req.headers.get("origin")), "access-control-max-age": "600" } });
}

async function readBody(req: NextRequest): Promise<Record<string, unknown> | null> {
  if (Number(req.headers.get("content-length") ?? 0) > BODY_LIMIT) return null;
  const text = await req.text().catch(() => "");
  if (!text || text.length > BODY_LIMIT) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

export async function POST(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const origin = req.headers.get("origin");
  let tenantId: string;
  try {
    const tenant = await currentTenant();
    if (tenant.status !== "ACTIVE" || restoreInProgressFor(tenant)) return answer({ ok: false, error: "The chat is unavailable just now." }, 503, origin);
    tenantId = tenant.id;
  } catch (err) {
    if (err instanceof TenantHostMismatch || err instanceof TenantNotFound || err instanceof TenantNotResolved) return answer({ ok: false }, 404, origin);
    throw err;
  }
  const body = await readBody(req);
  if (!body) return answer({ ok: false, error: "That message couldn't be read." }, 400, origin);

  const channel = await webChannel((await params).key);
  if (!channel || !(await moduleAvailableForTenant("inbox"))) return answer({ ok: false }, 404, origin);
  const settings = channelSettings(channel.settings, "WEB");
  // A channel limited to some sites answers no other — a browser says which site a call came from.
  if (settings.allowedSites.length && (!origin || !settings.allowedSites.includes(origin.toLowerCase()))) return answer({ ok: false, error: "This site can't show the chat." }, 403, origin);

  const ip = clientIpFrom(req.headers) ?? "unknown";
  const k = (what: string) => `inbox|${tenantId}|${channel.id}|${what}`;
  const op = str(body.op);

  if (op === "config") {
    if (!siteAllowance([{ key: k(`config:${ip}`), max: 120 }], TEN_MINUTES)) return answer({ ok: false }, 429, origin);
    // Outside the channel's office hours the bubble says so up front, as the conversation will.
    const away = settings.hours.on && !withinHours(settings.hours, (await workspaceClock()).parts(new Date())) ? settings.hours.away : null;
    return answer({ ok: true, title: settings.look.title, colour: settings.look.colour, position: settings.look.position, greeting: settings.greeting, assistant: settings.bot.name || null, away }, 200, origin);
  }

  if (op === "poll") {
    // Every 2.5 seconds while a chat is open, so typing shows as it happens.
    if (!siteAllowance([{ key: k(`poll:${ip}`), max: 900 }], TEN_MINUTES)) return answer({ ok: false }, 429, origin);
    const token = str(body.token);
    const [messages, presence] = await Promise.all([webMessages(channel.id, token, str(body.after) || null), webPresence(channel.id, token)]);
    // As a chat app shows it: who on the team is typing, and whether the visitor's last message was seen.
    return answer(messages ? { ok: true, messages, typing: presence?.typing ?? null, seen: presence?.seen ?? false } : { ok: true, messages: [], forget: true }, 200, origin);
  }

  if (op === "send") {
    const text = str(body.text).trim();
    if (!text) return answer({ ok: false, error: "Write something first." }, 400, origin);
    if (text.length > INBOX_LIMITS.message) return answer({ ok: false, error: "That message is too long." }, 400, origin);
    const token = str(body.token) || null;
    const limits = [
      { key: k(`send:${ip}`), max: 40 },
      { key: k("send:all"), max: 600 },
      // A new conversation each time is what a script filling the inbox would do.
      ...(token ? [] : [{ key: k(`new:${ip}`), max: 6 }]),
    ];
    if (!siteAllowance(limits, TEN_MINUTES)) return answer({ ok: false, error: "Too many messages just now. Please wait a few minutes." }, 429, origin);
    const page = str(body.page);
    const made = await receiveWebMessage(channel, { token, text, pageUrl: /^https?:\/\//.test(page) ? page.slice(0, 500) : null });
    return answer({ ok: true, token: made.token, messages: (await webMessages(channel.id, made.token, null)) ?? [] }, 200, origin);
  }

  return answer({ ok: false, error: "Unknown request." }, 400, origin);
}
