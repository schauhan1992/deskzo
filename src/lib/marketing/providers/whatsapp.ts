import {
  asError,
  networkFailure,
  requireSecret,
  retryableStatus,
  type MessageProvider,
  type ProviderConfig,
} from "@/lib/marketing/providers/types";

/**
 * WhatsApp, through Meta's Cloud API.
 *
 * Worth being blunt about what this can and cannot do, because it is not like email:
 *
 *   · Outside a 24-hour window opened by the customer messaging *us*, only a **pre-approved
 *     template** may be sent. Free text is rejected. So `whatsappTemplateName` on the template row
 *     is not optional metadata — it is the message.
 *   · Marketing templates need recorded opt-in. That lives in `ContactConsent`, and the ordinary
 *     suppression rules already enforce it.
 *   · Getting a WABA, a verified number and approved templates is weeks of external process. Until
 *     then this provider is simply disabled, which is a configuration state rather than a fault.
 *
 * A BSP (Gupshup, Interakt, Twilio) wraps the same API with a different envelope. Each would be
 * another `MessageProvider` beside this one rather than a change to it.
 */

const GRAPH_VERSION = "v21.0";

/** WhatsApp wants digits only, with the country code and no plus. */
export function whatsappNumber(phone: string): string | null {
  const digits = phone.replace(/[^0-9]/g, "");
  if (digits.length < 10) return null;
  // A bare Indian ten-digit number is the common case in this data, so assume +91 rather than
  // sending it somewhere unpredictable.
  if (digits.length === 10) return `91${digits}`;
  return digits;
}

export const whatsappCloudProvider: MessageProvider = {
  key: "whatsapp_cloud",
  label: "WhatsApp (Meta Cloud API)",
  kind: "WHATSAPP",
  needs: [
    { key: "phoneNumberId", label: "Phone number ID", hint: "From Meta Business → WhatsApp → API setup" },
    { key: "languageCode", label: "Template language", hint: "e.g. en or en_GB" },
    { key: "accessToken", label: "Access token", hint: "A permanent system-user token", secret: true },
  ],
  async send(message, config) {
    const token = requireSecret(config);
    const phoneNumberId = String(config.config?.phoneNumberId ?? "").trim();
    const language = String(config.config?.languageCode ?? "en").trim();
    if (!token || !phoneNumberId) {
      return { ok: false, retryable: false, error: "WhatsApp is not configured." };
    }

    const to = whatsappNumber(message.to);
    if (!to) return { ok: false, retryable: false, error: "That isn't a usable phone number." };

    // The approved template's name travels in `subject`; the body carries its variables, in order.
    const templateName = message.subject?.trim();
    if (!templateName) {
      return { ok: false, retryable: false, error: "No approved template name on this message." };
    }
    const variables = message.html
      .split("\n")
      .map((v) => v.trim())
      .filter(Boolean);

    try {
      const response = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to,
          type: "template",
          template: {
            name: templateName,
            language: { code: language },
            components:
              variables.length > 0
                ? [{ type: "body", parameters: variables.map((text) => ({ type: "text", text })) }]
                : undefined,
          },
        }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        messages?: { id: string }[];
        error?: { message?: string };
      };
      if (!response.ok) {
        return {
          ok: false,
          retryable: retryableStatus(response.status),
          error: body.error?.message ?? `WhatsApp returned ${response.status}.`,
        };
      }
      return { ok: true, providerMessageId: body.messages?.[0]?.id ?? null };
    } catch (err) {
      return networkFailure(err);
    }
  },
  async verify(config: ProviderConfig) {
    const token = requireSecret(config);
    const phoneNumberId = String(config.config?.phoneNumberId ?? "").trim();
    if (!token || !phoneNumberId) return { ok: false, detail: "Token and phone number ID are both needed." };
    try {
      const response = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
        return { ok: false, detail: body.error?.message ?? `WhatsApp returned ${response.status}.` };
      }
      return { ok: true, detail: "The number and token check out." };
    } catch (err) {
      return { ok: false, detail: `Could not reach WhatsApp: ${asError(err)}` };
    }
  },
};

export const WHATSAPP_PROVIDERS: MessageProvider[] = [whatsappCloudProvider];
