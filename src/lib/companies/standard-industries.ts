/**
 * The industries every workspace starts with (owner, 8 Oct 2026) — so a company or a vendor is given
 * one by picking, not by an admin first building the list in Settings › Lists. Added to every
 * workspace by migration 20261028100000_standard_industries, skipping any name it already has
 * (whatever its capitals); a workspace's own industries are kept, and admins still add, rename and
 * remove them. check:vendor-banking holds the migration and this list equal, and the data reset puts
 * them back (src/lib/data-reset.ts).
 *
 * Short names, as a list reads in a dropdown — and the ones workspaces already used, so an existing
 * list gains what it lacks rather than near-duplicates of what it has.
 */
export const STANDARD_INDUSTRIES: readonly string[] = [
  "Agriculture",
  "Automotive",
  "Aviation",
  "BFSI",
  "Biotechnology",
  "Chemicals",
  "Construction",
  "Consulting",
  "Consumer Electronics",
  "Defence",
  "E-commerce",
  "Education",
  "Energy & Power",
  "Engineering",
  "FMCG",
  "Food & Beverages",
  "Gems & Jewellery",
  "Government",
  "Healthcare",
  "Hospitality",
  "IT Services",
  "Legal",
  "Logistics",
  "Manufacturing",
  "Media",
  "Metals & Mining",
  "NGO",
  "Oil & Gas",
  "Pharmaceuticals",
  "Professional Services",
  "Real Estate",
  "Retail",
  "Software",
  "Telecom",
  "Textiles",
  "Trading & Distribution",
  "Transportation",
  "Travel & Tourism",
  "Utilities",
  "Other",
];
