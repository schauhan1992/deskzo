/**
 * Deskzo One — tickets by email: the Cloudflare Email Worker for tickets.deskzo.com.
 *
 * Cloudflare Email Routing hands every email for <anything>@tickets.deskzo.com to this worker (a
 * catch-all rule, "Send to a Worker"). It posts the email, whole and untouched, to Deskzo, signed with
 * the secret the two share. Deskzo decides which workspace it is for and what it becomes
 * (src/lib/support-mail).
 *
 * Settings → Variables and Secrets on the worker:
 *   DESKZO_INBOUND_URL     https://deskzo.com/api/platform/inbound-email
 *   DESKZO_INBOUND_SECRET  the same value as INBOUND_MAIL_SECRET on the Deskzo application (a secret)
 *
 * What the sender sees:
 *   - Deskzo has no helpdesk at that address (404): the email bounces, saying so.
 *   - Deskzo answered anything else that isn't OK: the worker fails, and the sender's mail server tries
 *     again later. An email is never silently lost.
 */

const encoder = new TextEncoder();

function base64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

async function sign(secret, text) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(text)));
  return [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const worker = {
  async email(message, env) {
    const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
    const body = JSON.stringify({ recipient: message.to, sender: message.from, raw: base64(raw) });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const response = await fetch(env.DESKZO_INBOUND_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-deskzo-timestamp": timestamp,
        "x-deskzo-signature": await sign(env.DESKZO_INBOUND_SECRET, `${timestamp}.${body}`),
      },
      body,
    });
    if (response.status === 404) {
      message.setReject("No helpdesk answers at this address.");
      return;
    }
    if (!response.ok) throw new Error(`Deskzo answered ${response.status}`);
  },
};

export default worker;
