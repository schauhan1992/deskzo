import type { WorkplaceProvider } from "@/lib/workplace/providers";

/** A message sent as a person from their own mailbox — Outlook, Gmail or Zoho Mail (src/lib/mail/mailbox.ts). */
export type OutgoingMail = {
  subject: string;
  html: string;
  to: { name: string | null; email: string }[];
  attachments: { name: string; contentType: string; bytes: Buffer }[];
};

export type SendOutcome = { ok: true; mailbox: string; provider: WorkplaceProvider } | { ok: false; error: string; reconnect: boolean };

/** What a provider's token endpoint gave back. */
export type TokenSet = { accessToken: string; refreshToken: string | null; expiresAt: Date; scope: string };
export type TokenOutcome = { ok: true; tokens: TokenSet } | { ok: false; error: string; revoked: boolean };

/** One attempt at a send through a provider's API. A 401 is the caller's to retry with a fresh token. */
export type ProviderSend = { ok: true } | { ok: false; status: number; error: string };
