-- An authenticator part-way through enrolment, held apart from the live one.
--
-- Setup used to overwrite `twoFactorSecretCipher` and blank `twoFactorEnabledAt` in one update, so
-- a stolen session cookie could switch an account's second factor off without knowing the password
-- and then enrol one the attacker controlled. The new secret now waits here until a code proves it.
ALTER TABLE "users" ADD COLUMN "twoFactorPendingCipher" TEXT;
