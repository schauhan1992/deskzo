-- The authenticator app choice (20261018100000_workplace_sign_in_and_mail) comes out again before it was
-- ever released (owner, 2 Oct 2026): two-factor works with any authenticator app, as it always has.
ALTER TABLE "security_settings" DROP COLUMN "authenticatorApp";
DROP TYPE "AuthenticatorApp";
