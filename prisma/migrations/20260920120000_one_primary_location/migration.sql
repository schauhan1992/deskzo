-- At most one primary location per company.
--
-- `isPrimary` was a plain boolean with nothing enforcing it, so two locations could both be primary
-- and none had to be. That is tolerable while it only drives which address appears first on a
-- screen; it stops being tolerable the moment anything keys off "the primary location" — an export
-- identifying a company by its primary GSTIN, an invoice picking a place of supply. A key resolved
-- by an unconstrained flag is not a key.
--
-- A partial unique index rather than a plain one: `isPrimary = false` rows are unconstrained, which
-- is what we want, and Prisma has no syntax for this so it lives here rather than in the schema.

-- Fails loudly rather than silently dropping a flag, if any company already has two.
DO $$
DECLARE offenders text;
BEGIN
  SELECT string_agg(DISTINCT "companyId", ', ') INTO offenders
  FROM "company_locations" WHERE "isPrimary" GROUP BY "companyId" HAVING count(*) > 1;
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'Companies with more than one primary location: %. Resolve them before applying.', offenders;
  END IF;
END $$;

CREATE UNIQUE INDEX "company_locations_one_primary_per_company"
  ON "company_locations"("companyId")
  WHERE "isPrimary";
