/**
 * Runs once as the Next server starts, before it answers anything.
 *
 * Marks the process as the Next server, which is what switches the tenancy fallback off
 * (src/lib/tenancy/resolve.ts): scripts and check suites may act as the first workspace when
 * nothing says otherwise; a server answering real requests may not.
 */
export function register() {
  (globalThis as { __wroffyInNext?: boolean }).__wroffyInNext = true;
}
