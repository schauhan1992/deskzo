/**
 * The platform's names, as constants — pure, so client components can show them too (it lives outside
 * src/lib/platform, which client code may not import).
 *
 *   · The product, what customers sign up for and see in their tab: "Deskzo One". Its live value is
 *     the website's name as the CMS last published it (`platformBrandName()` in
 *     src/lib/platform/brand.ts); this is the fallback, and the default before anything is published.
 *   · The company behind it — who looks after a plan, whose support staff ask to look inside a
 *     workspace, who runs the console: "Deskzo".
 *
 * Internal identifiers keep their old names on purpose: cookie names, key-derivation labels, database
 * and package names. Changing those would sign everybody out or make sealed data unreadable, and no
 * customer ever sees them.
 */

export const DEFAULT_BRAND_NAME = "Deskzo One";

export const COMPANY_NAME = "Deskzo";
