import { DefinitionList } from "@/components/console/kit/panel";
import { COUNTRIES } from "@/lib/geo/countries";
import type { PartnerAddress } from "@/lib/partners/portal-data";
import type { PayoutMask } from "@/lib/partners/types";

/**
 * Small pieces the company profile and a statement's recorded details share. Server-safe (and
 * client-safe: no hooks, no directive, the country list is plain data).
 */

const COUNTRY_NAMES = new Map(COUNTRIES.map((c) => [c.code, c.name]));

/** "IN" → "India"; a code the list does not know shows as itself. */
export function countryName(code: string | null | undefined): string {
  const key = String(code ?? "").trim().toUpperCase();
  if (!key) return "—";
  return COUNTRY_NAMES.get(key) ?? key;
}

/** The address's lines that are filled in, in order; the postal code joins the city's line. */
export function addressLines(address: PartnerAddress): string[] {
  const cityLine = [address.city, address.region, address.postalCode].filter((part): part is string => !!part && !!part.trim()).join(", ");
  return [address.line1, address.line2, cityLine].filter((line): line is string => !!line && !!line.trim());
}

export function AddressBlock({ address }: { address: PartnerAddress }) {
  const lines = addressLines(address);
  if (lines.length === 0) return <span className="text-muted">Not on file</span>;
  return (
    <span className="block">
      {lines.map((line, i) => (
        <span key={`${i}-${line}`} className="block">
          {line}
        </span>
      ))}
    </span>
  );
}

/** Four bullets and a space before the last four: the only part of an account a screen ever shows. */
const MASKED = "••••";

/** "•••• 9876" — as one text run. */
export const maskedAccount = (last4: string) => `${MASKED} ${String(last4 ?? "").slice(-4)}`;

/**
 * The payout details on file, as their mask: holder, bank, country, currency, the branch or bank code
 * (IFSC or SWIFT), and the account as "•••• " and its last four. Never more — the full details are
 * sealed, and not even their owner sees them again.
 */
export function PayoutMaskList({ mask }: { mask: PayoutMask }) {
  return (
    <DefinitionList
      items={[
        { term: "Account holder", value: mask.accountHolder },
        { term: "Bank", value: mask.bankName },
        { term: "Account", value: <span className="font-mono">{maskedAccount(mask.last4)}</span> },
        { term: "Country", value: countryName(mask.country) },
        { term: "Currency", value: mask.currency || "—" },
        ...(mask.ifsc ? [{ term: "IFSC", value: <span className="font-mono">{mask.ifsc}</span> }] : []),
        ...(mask.swift ? [{ term: "SWIFT (BIC)", value: <span className="font-mono">{mask.swift}</span> }] : []),
      ]}
    />
  );
}
