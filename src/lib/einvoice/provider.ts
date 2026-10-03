import { buildEInvoicePayload, type EInvoiceDocument } from "@/lib/einvoice/payload";
import { indiaClock } from "@/lib/time/zone";

/**
 * The IRP behind one interface, so the app never talks to the portal directly.
 *
 * Two implementations ship: `mock`, which produces a well-formed IRN locally for development and
 * demos, and `nic`, which calls the real NIC API (sandbox or production, same shape — only the
 * base URL differs). Swapping between them is a settings change, not a code change.
 */

export type EInvoiceResult =
  | { ok: true; irn: string; ackNo: string; ackDate: Date; signedQrCode: string }
  | { ok: false; error: string };

export type CancelResult = { ok: true } | { ok: false; error: string };

export type ProviderConfig = {
  provider: string;
  username?: string | null;
  password?: string | null;
  clientId?: string | null;
  clientSecret?: string | null;
  gstin?: string | null;
};

export interface EInvoiceProvider {
  readonly name: string;
  generate(doc: EInvoiceDocument): Promise<EInvoiceResult>;
  cancel(irn: string, reason: string, remark: string): Promise<CancelResult>;
}

/**
 * Local stand-in. Produces the same 64-character IRN shape the portal returns (a SHA-256 of
 * GSTIN + document type + number + financial year, which is exactly how the real IRN is derived),
 * so downstream code, storage and display are exercised for real without portal access.
 */
class MockProvider implements EInvoiceProvider {
  readonly name = "mock";

  constructor(private config: ProviderConfig) {}

  async generate(doc: EInvoiceDocument): Promise<EInvoiceResult> {
    const { createHash } = await import("node:crypto");
    const seed = `${this.config.gstin ?? doc.seller.gstin ?? "UNKNOWN"}${doc.docType}${doc.docNumber}`;
    const irn = createHash("sha256").update(seed).digest("hex");
    const ackDate = new Date();
    // The portal's QR is a signed JWT; a base64 payload is enough to prove the plumbing works.
    const signedQrCode = Buffer.from(
      JSON.stringify({
        SellerGstin: doc.seller.gstin,
        BuyerGstin: doc.buyer.gstin ?? "URP",
        DocNo: doc.docNumber,
        DocTyp: doc.docType === "CREDIT_NOTE" ? "CRN" : "INV",
        // India's day, as the IRP dates a document — not the UTC one.
        DocDt: indiaClock.dateKey(doc.issueDate),
        TotInvVal: doc.total,
        Irn: irn,
      }),
    ).toString("base64");

    return {
      ok: true,
      irn,
      ackNo: String(Date.now()).slice(-10),
      ackDate,
      signedQrCode,
    };
  }

  async cancel(): Promise<CancelResult> {
    return { ok: true };
  }
}

const NIC_BASE_URLS: Record<string, string> = {
  nic_sandbox: "https://einv-apisandbox.nic.in",
  nic_production: "https://einvoice1.gst.gov.in",
};

/**
 * The real NIC API. Auth returns a short-lived token which is cached for the process lifetime;
 * every failure path returns a readable message rather than throwing, because a portal outage must
 * leave the invoice saved and retryable, never lose it.
 */
class NicProvider implements EInvoiceProvider {
  readonly name = "nic";
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private config: ProviderConfig,
    private baseUrl: string,
  ) {}

  private headers(extra: Record<string, string> = {}) {
    return {
      "Content-Type": "application/json",
      client_id: this.config.clientId ?? "",
      client_secret: this.config.clientSecret ?? "",
      Gstin: this.config.gstin ?? "",
      ...extra,
    };
  }

  private async authenticate(): Promise<string | null> {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value;
    try {
      const response = await fetch(`${this.baseUrl}/eivital/v1.04/auth`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ UserName: this.config.username, Password: this.config.password }),
      });
      const body = await response.json();
      const authToken = body?.Data?.AuthToken;
      if (!authToken) return null;
      // The portal issues ~6h tokens; refresh a little early rather than racing the expiry.
      this.token = { value: authToken, expiresAt: Date.now() + 5 * 60 * 60 * 1000 };
      return authToken;
    } catch {
      return null;
    }
  }

  async generate(doc: EInvoiceDocument): Promise<EInvoiceResult> {
    const token = await this.authenticate();
    if (!token) return { ok: false, error: "Couldn't authenticate with the IRP — check the credentials in Settings." };

    try {
      const response = await fetch(`${this.baseUrl}/eicore/v1.03/Invoice`, {
        method: "POST",
        headers: this.headers({ AuthToken: token, user_name: this.config.username ?? "" }),
        body: JSON.stringify(buildEInvoicePayload(doc)),
      });
      const body = await response.json();

      if (body?.Status !== 1 || !body?.Data) {
        const message = Array.isArray(body?.ErrorDetails)
          ? body.ErrorDetails.map((e: { ErrorMessage?: string }) => e.ErrorMessage).filter(Boolean).join("; ")
          : (body?.ErrorDetails ?? body?.ErrorMessage ?? "The IRP rejected the invoice.");
        return { ok: false, error: String(message) };
      }

      const data = typeof body.Data === "string" ? JSON.parse(body.Data) : body.Data;
      return {
        ok: true,
        irn: data.Irn,
        ackNo: String(data.AckNo),
        ackDate: irpTime(data.AckDt),
        signedQrCode: data.SignedQRCode,
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Couldn't reach the IRP." };
    }
  }

  async cancel(irn: string, reason: string, remark: string): Promise<CancelResult> {
    const token = await this.authenticate();
    if (!token) return { ok: false, error: "Couldn't authenticate with the IRP." };
    try {
      const response = await fetch(`${this.baseUrl}/eicore/v1.03/Cancel`, {
        method: "POST",
        headers: this.headers({ AuthToken: token, user_name: this.config.username ?? "" }),
        body: JSON.stringify({ Irn: irn, CnlRsn: reason, CnlRem: remark }),
      });
      const body = await response.json();
      if (body?.Status !== 1) {
        return { ok: false, error: String(body?.ErrorDetails ?? "The IRP refused the cancellation.") };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Couldn't reach the IRP." };
    }
  }
}

/**
 * The IRP's acknowledgement time — "2026-10-02 18:30:00", India's, with no zone on it. `new Date()` read
 * that in the server's zone: five and a half hours late on a UTC server, which stretched the 24-hour
 * cancellation window past the portal's own. India's clock reads it to the minute and the seconds go
 * on after; anything else is taken as `Date` reads it, as before.
 */
function irpTime(value: unknown): Date {
  const text = String(value ?? "").trim();
  const bare = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?$/.exec(text);
  if (bare) {
    const minute = indiaClock.parseInput(`${bare[1]}T${bare[2]}`);
    if (minute) return new Date(minute.getTime() + Number(bare[3] ?? 0) * 1000);
  }
  return new Date(text);
}

export function createEInvoiceProvider(config: ProviderConfig): EInvoiceProvider {
  const baseUrl = NIC_BASE_URLS[config.provider];
  if (!baseUrl) return new MockProvider(config);
  return new NicProvider(config, baseUrl);
}

export const EINVOICE_PROVIDERS = [
  { value: "mock", label: "Mock (no portal — for testing)" },
  { value: "nic_sandbox", label: "NIC sandbox" },
  { value: "nic_production", label: "NIC production" },
] as const;

/** The portal only accepts these codes, and only within 24 hours of generating the IRN. */
export const CANCEL_REASONS = [
  { value: "1", label: "Duplicate" },
  { value: "2", label: "Data entry mistake" },
  { value: "3", label: "Order cancelled" },
  { value: "4", label: "Other" },
] as const;

export const CANCELLATION_WINDOW_HOURS = 24;

/** Whether the portal will still accept a cancellation for an IRN acknowledged at this time. */
export function isWithinCancellationWindow(ackDate: Date | string | null | undefined) {
  if (!ackDate) return false;
  const hours = (Date.now() - new Date(ackDate).getTime()) / (1000 * 60 * 60);
  return hours <= CANCELLATION_WINDOW_HOURS;
}
