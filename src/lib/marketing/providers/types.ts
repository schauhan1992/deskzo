/**
 * One interface, several backends.
 *
 * The field that matters most here is `retryable`. A 5xx or a rate-limit means "ask again in a
 * minute"; a rejected address means "never ask again". Getting that distinction wrong is precisely
 * how a system sends the same email twice — it retries something that already worked, or that was
 * never going to.
 */

export type OutboundMessage = {
  to: string;
  toName?: string | null;
  subject: string;
  html: string;
  text?: string | null;
  /**
   * The one-click unsubscribe header pair. Google and Yahoo now effectively require them of bulk
   * senders, and a provider that silently drops them is one whose mail starts landing in spam.
   */
  listUnsubscribe?: string | null;
  listUnsubscribePost?: boolean;
  headers?: Record<string, string>;
};

export type SendResult =
  | { ok: true; providerMessageId: string | null }
  | { ok: false; retryable: boolean; error: string };

/** A provider row with its secret already decrypted — never let this reach a client component. */
export type ProviderConfig = {
  key: string;
  label: string;
  fromName: string | null;
  fromEmail: string | null;
  replyTo: string | null;
  config: Record<string, unknown>;
  secret: string | null;
};

export type MessageProvider = {
  key: string;
  label: string;
  kind: "EMAIL" | "WHATSAPP";
  /** What has to be filled in before this one can be enabled, in the settings screen's words. */
  needs: { key: string; label: string; hint?: string; secret?: boolean }[];
  send(message: OutboundMessage, config: ProviderConfig): Promise<SendResult>;
  verify(config: ProviderConfig): Promise<{ ok: boolean; detail: string }>;
};

/**
 * Whether an HTTP failure is worth trying again.
 *
 * 429 and 5xx are the provider's problem and will pass. Everything else in the 4xx range is ours —
 * a bad key, a malformed address, a suppressed recipient — and retrying it just burns the quota
 * and, for a partially-succeeded send, risks a duplicate.
 */
export function retryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export function asError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** A network failure never got as far as the provider, so it is always safe to try again. */
export function networkFailure(err: unknown): SendResult {
  return { ok: false, retryable: true, error: `Could not reach the provider: ${asError(err)}` };
}

export function requireSecret(config: ProviderConfig): string | null {
  const secret = config.secret?.trim();
  return secret && secret.length > 0 ? secret : null;
}

export function fromHeader(config: ProviderConfig): string {
  const email = config.fromEmail?.trim() ?? "";
  const name = config.fromName?.trim();
  return name ? `${name} <${email}>` : email;
}

/** Headers every outbound message carries, whichever backend puts them on the wire. */
export function standardHeaders(message: OutboundMessage): Record<string, string> {
  const headers: Record<string, string> = { ...(message.headers ?? {}) };
  if (message.listUnsubscribe) {
    headers["List-Unsubscribe"] = `<${message.listUnsubscribe}>`;
    if (message.listUnsubscribePost !== false) {
      headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
    }
  }
  return headers;
}

/** A readable plain-text part, so a message is not HTML-only — which reads as spam on its own. */
export function textFallback(message: OutboundMessage): string {
  if (message.text?.trim()) return message.text;
  return message.html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
