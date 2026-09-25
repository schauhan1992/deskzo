/**
 * A company name reduced to what makes it the same company: case and spacing ignored.
 *
 * `companies.normalizedName` is unique on exactly this, so it is *the* duplicate rule — and it lives
 * here, on its own, so a client component can apply it without importing the validation schemas and
 * everything they pull in.
 */
export function normalizeCompanyName(name: string) {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Whether a picker should offer "create new company" for what has been typed.
 *
 * Not when the name is already on the list — offering it anyway invited a click that could only end
 * in "already exists", and taught people to scroll past the real record to the create row. Compared
 * by the duplicate rule above, so "acme  chemicals" is the same as "Acme Chemicals".
 */
export function offersCreate(typed: string, existingNames: string[]): boolean {
  const key = normalizeCompanyName(typed);
  if (!key) return false;
  return !existingNames.some((name) => normalizeCompanyName(name) === key);
}
