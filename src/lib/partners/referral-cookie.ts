/**
 * The partner programme's first-touch referral cookie on the public site — set by the proxy (src/proxy.ts)
 * or by a visitor agreeing to it (src/actions/platform/site.ts setCookieConsent), read by signup — and the
 * visitor's cookie choice (owner, 23 Oct 2026): the referral cookie is the site's one cookie that is not
 * strictly needed, so it is set only once the visitor has agreed (src/components/site/cookie-notice.tsx).
 */

export const REFERRAL_COOKIE = "deskzo_ref";

/** A referral code's shape: 6–40 characters, lower-case letters and digits in hyphenated words. */
export const REFERRAL_CODE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const isReferralCode = (ref: string) => ref.length >= 6 && ref.length <= 40 && REFERRAL_CODE.test(ref);

/** "accepted" or "declined": the visitor's answer to the cookie notice. Readable by the page, which asks it. */
export const CONSENT_COOKIE = "deskzo_consent";
export const CONSENT_MAX_AGE = 365 * 86_400;
