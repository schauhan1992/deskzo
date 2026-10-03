/**
 * A grant's `expiresAt` is the midnight that ends its last day, on the workspace's clock
 * (src/actions/access.ts). The day to show — "until 30 Oct" — is the one just before it.
 */
export function lastDayOf(expiresAt: Date | string): Date {
  return new Date(new Date(expiresAt).getTime() - 1);
}
