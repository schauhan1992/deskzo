/**
 * The postal address at the bottom of a marketing email.
 *
 * Providers want one, and its absence is a common reason bulk mail is filtered — but the app
 * already knows where the company is, because it prints that on every invoice. Making somebody
 * retype it into a second field, and then warning them when they haven't, is the app being obtuse
 * about a fact it holds.
 *
 * So it is **derived from the registered office unless somebody deliberately overrides it**, which
 * is the same distinction the letterhead draws: the wording of a letter is frozen when it is
 * drafted, the paper it prints on is read fresh. An override exists for the real case — a company
 * whose marketing should carry a different office from the one on the GST registration.
 */

export type AddressParts = {
  legalName: string;
  tradeName: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
};

export type FooterAddress = {
  text: string | null;
  /** Where it came from, so the settings screen can say so rather than looking empty. */
  source: "OVERRIDE" | "REGISTERED" | "NONE";
};

/**
 * Formats the registered office the way a postal address reads, dropping whatever is missing.
 *
 * A half-filled address still beats none — "Wroffy Technologies, Mumbai" is a real address and an
 * empty footer is a filtered email — so this returns what it has rather than insisting on all of it.
 */
export function formatRegisteredAddress(org: AddressParts): string | null {
  const name = org.legalName?.trim() || org.tradeName?.trim() || null;

  const street = [org.addressLine1, org.addressLine2]
    .map((part) => part?.trim())
    .filter((part): part is string => !!part)
    .join(", ");

  // "Mumbai, Maharashtra 400069" — the pincode belongs to the state, not after another comma.
  const region = [org.city?.trim(), org.state?.trim()].filter(Boolean).join(", ");
  const locality = [region, org.pincode?.trim()].filter(Boolean).join(" ");

  const lines = [name, street, locality].filter((line): line is string => !!line && line.length > 0);
  return lines.length > 0 ? lines.join("\n") : null;
}

/** What actually goes in the footer, and where it came from. */
export function postalAddressFor(
  org: AddressParts & { marketingPostalAddress: string | null },
): FooterAddress {
  const override = org.marketingPostalAddress?.trim();
  if (override) return { text: override, source: "OVERRIDE" };

  const registered = formatRegisteredAddress(org);
  if (registered) return { text: registered, source: "REGISTERED" };

  return { text: null, source: "NONE" };
}
