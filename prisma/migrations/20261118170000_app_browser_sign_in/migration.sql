-- Signing in to the Deskzo app through the phone's browser (owner, 18 Oct 2026): the PKCE challenge a pairing code
-- was issued for, so only the app that started the sign-in can spend it.
ALTER TABLE "app_pairings" ADD COLUMN "codeChallenge" TEXT;
