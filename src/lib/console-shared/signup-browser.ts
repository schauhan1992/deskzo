/**
 * How long a signing-up browser keeps its signup — its cookie's life (src/actions/platform/signup.ts).
 * A code sent after that can't finish the signup: the person signs up again. Client-safe, for the
 * console's Signups page; src/lib/platform/signup-code.ts reads the same.
 */
export const SIGNUP_BROWSER_MS = 24 * 60 * 60_000;
