import { buildEwayPayload, type EwayDocument } from "@/lib/eway/payload";
import { IST_OFFSET_MS } from "@/lib/india-time";
import { validityFor } from "@/lib/eway/rules";

/**
 * The e-way bill portal behind one interface, so the app never talks to it directly.
 *
 * The same shape as `einvoice/provider.ts`, deliberately — same portal operator, same credentials,
 * same auth dance, and somebody who has read one should not have to learn a second. Two
 * implementations ship: `mock`, which issues a well-formed bill locally, and `nic`, which calls the
 * real API.
 *
 * ## Three operations, not one
 *
 * Generating is the obvious one. The other two are what make the module usable in a warehouse:
 *
 *   · **Part B** — the vehicle. A bill is routinely raised in the morning against a transporter id
 *     and the lorry assigned at four, so updating the vehicle on an existing bill is the ordinary
 *     case rather than a correction.
 *   · **Cancel**, within 24 hours, which is what happens when a despatch is called off.
 *
 * ## Not yet run against the real portal
 *
 * As with the IRP provider: the shape follows the published API and every failure path returns a
 * readable message rather than throwing, but everything verified here went through `mock`. Sandbox
 * credentials are needed before the NIC path can be called working, and the settings screen should
 * be left on `mock` until somebody has.
 */

export type EwayResult =
  | { ok: true; ewayBillNumber: string; ewayBillDate: Date; validUntil: Date }
  | { ok: false; error: string };

export type EwayActionResult = { ok: true } | { ok: false; error: string };

/** What the portal holds against a bill number somebody raised there. */
export type EwayFetchResult =
  | {
      ok: true;
      ewayBillNumber: string;
      ewayBillDate: Date;
      validUntil: Date;
      status: "GENERATED" | "CANCELLED";
      documentNumber: string | null;
      vehicleNumber: string | null;
      transporterName: string | null;
    }
  | { ok: false; error: string };

export type EwayProviderConfig = {
  provider: string;
  username?: string | null;
  password?: string | null;
  clientId?: string | null;
  clientSecret?: string | null;
  gstin?: string | null;
};

export interface EwayProvider {
  readonly name: string;
  generate(doc: EwayDocument): Promise<EwayResult>;
  /** Part B. Adds or changes the vehicle on a bill already issued. */
  updateVehicle(input: {
    ewayBillNumber: string;
    vehicleNumber: string;
    reasonCode: string;
    reasonNote: string;
    fromPlace: string;
    fromStateCode: string;
    transportMode: EwayDocument["transportMode"];
  }): Promise<EwayActionResult>;
  cancel(ewayBillNumber: string, reasonCode: string, remark: string): Promise<EwayActionResult>;
  /**
   * Read back a bill raised on the portal directly.
   *
   * So that recording one costs typing twelve digits rather than transcribing a number, a date and
   * an expiry off a screenshot — three chances to get it wrong, and the dates are the two that
   * matter, because an expiry typed a day long is a bill that reads valid here and expired at a
   * checkpoint.
   */
  fetch(ewayBillNumber: string): Promise<EwayFetchResult>;
}

/**
 * Local stand-in.
 *
 * Issues a 12-digit number in the portal's own shape and works out the validity with the real rule
 * from `rules.ts` — so the dates on screen, the expiry badge and the "extend it" prompt are all
 * exercised for real without portal access. The only thing that is fake is the number.
 */
class MockEwayProvider implements EwayProvider {
  readonly name = "mock";

  constructor(private config: EwayProviderConfig) {}

  async generate(doc: EwayDocument): Promise<EwayResult> {
    const { createHash } = await import("node:crypto");
    const seed = `${this.config.gstin ?? doc.from.gstin ?? "UNKNOWN"}${doc.documentNumber}${doc.documentDate.toISOString()}`;
    // The portal's numbers are 12 digits beginning 3 — close enough that anything validating the
    // shape downstream is genuinely exercised. Eleven hex digits stay inside a safe integer, so no
    // BigInt is needed and the build target stays where it is.
    const digits = parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 11), 16) % 100000000000;
    const ewayBillNumber = `3${String(digits).padStart(11, "0")}`;

    const ewayBillDate = new Date();
    const { validUntil } = validityFor(ewayBillDate, doc.distanceKm, doc.vehicleType);

    return { ok: true, ewayBillNumber, ewayBillDate, validUntil };
  }

  async updateVehicle(): Promise<EwayActionResult> {
    return { ok: true };
  }

  async cancel(): Promise<EwayActionResult> {
    return { ok: true };
  }

  async fetch(ewayBillNumber: string): Promise<EwayFetchResult> {
    if (!/^\d{12}$/.test(ewayBillNumber)) return { ok: false, error: "An e-way bill number is 12 digits." };
    // Raised today and good for a day, which is the shortest a real one can be — so anything that
    // treats a fetched bill as comfortably in date gets caught here rather than on the road.
    const ewayBillDate = new Date();
    const { validUntil } = validityFor(ewayBillDate, 100, "REGULAR");
    return {
      ok: true,
      ewayBillNumber,
      ewayBillDate,
      validUntil,
      status: "GENERATED",
      documentNumber: null,
      vehicleNumber: null,
      transporterName: null,
    };
  }
}

const NIC_BASE_URLS: Record<string, string> = {
  nic_sandbox: "https://ewb-apisandbox.nic.in",
  nic_production: "https://api.ewaybillgst.gov.in",
};

/** Why a vehicle is being changed. The portal takes a code, and refuses a bare update without one. */
export const VEHICLE_UPDATE_REASONS = [
  { code: "1", label: "Due to break down" },
  { code: "2", label: "Transhipment" },
  { code: "3", label: "Other" },
  { code: "4", label: "First time vehicle" },
] as const;

/** Why a bill is being cancelled, in the portal's own list. */
export const CANCEL_REASONS = [
  { code: "1", label: "Duplicate" },
  { code: "2", label: "Order cancelled" },
  { code: "3", label: "Data entry mistake" },
  { code: "4", label: "Others" },
] as const;

class NicEwayProvider implements EwayProvider {
  readonly name = "nic";
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private config: EwayProviderConfig,
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
      const response = await fetch(`${this.baseUrl}/ewayapi/v1.03/Authenticate`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ UserName: this.config.username, Password: this.config.password }),
      });
      const body = await response.json();
      const authToken = body?.authtoken ?? body?.Data?.AuthToken;
      if (!authToken) return null;
      // ~6 hours, refreshed early rather than racing the expiry.
      this.token = { value: authToken, expiresAt: Date.now() + 5 * 60 * 60 * 1000 };
      return authToken;
    } catch {
      return null;
    }
  }

  /** The portal reports failures as an array of codes; this turns them into one readable line. */
  private errorFrom(body: unknown): string {
    const record = body as { error?: unknown; errorCodes?: string; message?: string };
    if (typeof record?.error === "string") return record.error;
    if (Array.isArray(record?.error)) {
      return (record.error as { message?: string }[]).map((e) => e.message).filter(Boolean).join("; ");
    }
    if (record?.errorCodes) return `The portal refused it (${record.errorCodes}).`;
    if (record?.message) return String(record.message);
    return "The e-way bill portal refused the request.";
  }

  async generate(doc: EwayDocument): Promise<EwayResult> {
    const token = await this.authenticate();
    if (!token) {
      return { ok: false, error: "Couldn't authenticate with the e-way bill portal — check the credentials in Settings." };
    }

    try {
      const response = await fetch(`${this.baseUrl}/ewayapi/v1.03/GenEwayBill`, {
        method: "POST",
        headers: this.headers({ authtoken: token, user_name: this.config.username ?? "" }),
        body: JSON.stringify(buildEwayPayload(doc)),
      });
      const body = await response.json();

      const data = body?.Data ?? body;
      if (!data?.ewayBillNo) return { ok: false, error: this.errorFrom(body) };

      /**
       * The portal's own validity is taken over ours when it gives one.
       *
       * Ours is computed from the same published rule, but a disagreement between the two must be
       * resolved in favour of the document that would be produced at a roadside check.
       */
      const ewayBillDate = parsePortalDate(data.ewayBillDate) ?? new Date();
      const validUntil =
        parsePortalDate(data.validUpto) ?? validityFor(ewayBillDate, doc.distanceKm, doc.vehicleType).validUntil;

      return { ok: true, ewayBillNumber: String(data.ewayBillNo), ewayBillDate, validUntil };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Couldn't reach the e-way bill portal." };
    }
  }

  async updateVehicle(input: Parameters<EwayProvider["updateVehicle"]>[0]): Promise<EwayActionResult> {
    const token = await this.authenticate();
    if (!token) return { ok: false, error: "Couldn't authenticate with the e-way bill portal." };
    try {
      const response = await fetch(`${this.baseUrl}/ewayapi/v1.03/VEHEWB`, {
        method: "POST",
        headers: this.headers({ authtoken: token, user_name: this.config.username ?? "" }),
        body: JSON.stringify({
          ewbNo: Number(input.ewayBillNumber),
          vehicleNo: input.vehicleNumber,
          fromPlace: input.fromPlace,
          fromState: Number(input.fromStateCode),
          reasonCode: input.reasonCode,
          reasonRem: input.reasonNote,
          transDocNo: "",
          transDocDate: "",
          transMode: input.transportMode === "ROAD" ? "1" : input.transportMode === "RAIL" ? "2" : input.transportMode === "AIR" ? "3" : "4",
        }),
      });
      const body = await response.json();
      if (!(body?.Data?.vehUpdDate ?? body?.vehUpdDate)) return { ok: false, error: this.errorFrom(body) };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Couldn't reach the e-way bill portal." };
    }
  }

  async cancel(ewayBillNumber: string, reasonCode: string, remark: string): Promise<EwayActionResult> {
    const token = await this.authenticate();
    if (!token) return { ok: false, error: "Couldn't authenticate with the e-way bill portal." };
    try {
      const response = await fetch(`${this.baseUrl}/ewayapi/v1.03/CANEWB`, {
        method: "POST",
        headers: this.headers({ authtoken: token, user_name: this.config.username ?? "" }),
        body: JSON.stringify({ ewbNo: Number(ewayBillNumber), cancelRsnCode: Number(reasonCode), cancelRmrk: remark }),
      });
      const body = await response.json();
      if (!(body?.Data?.cancelDate ?? body?.cancelDate)) return { ok: false, error: this.errorFrom(body) };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Couldn't reach the e-way bill portal." };
    }
  }

  /**
   * `GetEwayBill` — the read side, and the only one of these that is a GET.
   *
   * The portal will only return bills raised on our own GSTIN, which is the whole reason this is
   * safe to expose: somebody typing a number they found cannot read a stranger's consignment out
   * of it. A number the portal does not recognise comes back as an error, which is the answer.
   */
  async fetch(ewayBillNumber: string): Promise<EwayFetchResult> {
    if (!/^\d{12}$/.test(ewayBillNumber)) return { ok: false, error: "An e-way bill number is 12 digits." };

    const token = await this.authenticate();
    if (!token) return { ok: false, error: "Couldn't authenticate with the e-way bill portal." };
    try {
      const response = await fetch(`${this.baseUrl}/ewayapi/GetEwayBill?ewbNo=${ewayBillNumber}`, {
        method: "GET",
        headers: this.headers({ authtoken: token, user_name: this.config.username ?? "" }),
      });
      const body = await response.json();
      const data = body?.Data ?? body;
      if (!data?.ewbNo) return { ok: false, error: this.errorFrom(body) };

      const ewayBillDate = parsePortalDate(data.ewayBillDate);
      const validUntil = parsePortalDate(data.validUpto);
      // Both dates or nothing. A bill recorded with a guessed expiry reads valid here and is
      // refused at a checkpoint, which is worse than not recording it at all.
      if (!ewayBillDate || !validUntil) {
        return { ok: false, error: "The portal returned that bill without usable dates." };
      }

      return {
        ok: true,
        ewayBillNumber: String(data.ewbNo),
        ewayBillDate,
        validUntil,
        status: String(data.status ?? "").toUpperCase() === "CNL" ? "CANCELLED" : "GENERATED",
        documentNumber: data.docNo ? String(data.docNo) : null,
        vehicleNumber: data.VehiclListDetails?.at?.(-1)?.vehicleNo ?? data.vehicleNo ?? null,
        transporterName: data.transporterName ? String(data.transporterName) : null,
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Couldn't reach the e-way bill portal." };
    }
  }
}

/**
 * `dd/mm/yyyy hh:mm:ss AM` — the portal's own format, which is not ISO and not parseable by `Date`.
 *
 * Returns null rather than an Invalid Date, so a caller falls back to the computed validity instead
 * of storing `NaN` as an expiry and showing every bill as expired.
 *
 * The portal's times are India's. Built as a UTC instant less 05:30 rather than with `new Date(y, m, …)`,
 * which reads them in the server's zone: on a UTC server a bill valid until 23:59 IST was stored as
 * valid until 05:29 the next morning.
 */
export function parsePortalDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const match = /^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?/i.exec(value.trim());
  if (!match) return null;

  const [, dd, mm, yyyy, hh, mi, ss, meridiem] = match;
  let hours = Number(hh ?? 0);
  if (meridiem?.toUpperCase() === "PM" && hours < 12) hours += 12;
  if (meridiem?.toUpperCase() === "AM" && hours === 12) hours = 0;

  const date = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), hours, Number(mi ?? 0), Number(ss ?? 0)) - IST_OFFSET_MS);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function createEwayProvider(config: EwayProviderConfig): EwayProvider {
  const baseUrl = NIC_BASE_URLS[config.provider];
  return baseUrl ? new NicEwayProvider(config, baseUrl) : new MockEwayProvider(config);
}
