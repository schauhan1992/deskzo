/**
 * Masking secrets in text the console shows: a provisioning job's error, a migration's output, a
 * failing job's last error, a webhook's error. Those are written by tools that sometimes quote what
 * they were given — a connection string with its password, a gateway key, an Authorization header.
 *
 * It is a last line of defence, not a licence: nothing secret is selected on purpose (see the safe
 * selects in src/lib/platform/console-guard.ts). What it knows to mask:
 *
 *   · credentials in a URL — `postgresql://user:password@host/db` keeps its scheme and host;
 *   · `password=…` / `pwd=…` pairs, as libpq and query strings write them;
 *   · Stripe secret, restricted and webhook-signing keys; Razorpay key ids;
 *   · `Bearer …` and `Basic …` credentials;
 *   · environment assignments of PLATFORM_* and anything named *_SECRET, *_KEY, *_TOKEN, *_PASSWORD.
 */

const MASK = "***";

const RULES: [RegExp, string][] = [
  // scheme://user:password@ → scheme://***:***@ (the host and path stay readable).
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]*@/gi, `$1${MASK}:${MASK}@`],
  [/\b(password|passwd|pwd)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&"']+)/gi, `$1$2${MASK}`],
  [/\b(sk|rk)_(live|test)_[A-Za-z0-9]+/g, `$1_$2_${MASK}`],
  [/\bwhsec_[A-Za-z0-9+/=]+/g, `whsec_${MASK}`],
  [/\brzp_(live|test)_[A-Za-z0-9]+/g, `rzp_$1_${MASK}`],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${MASK}`],
  [/\b(Basic)\s+[A-Za-z0-9+/=]{8,}/g, `$1 ${MASK}`],
  [/\b(PLATFORM_[A-Z0-9_]+|[A-Z0-9_]*_(?:SECRET|KEY|TOKEN|PASSWORD))(\s*=\s*)("[^"]*"|'[^']*'|\S+)/g, `$1$2${MASK}`],
];

export function redactSecrets(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  let out = String(text);
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return out;
}
