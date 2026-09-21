-- Resellers created before reseller_profiles existed have no profile, which would leave them
-- permanently unable to trade (order punching requires an ACTIVE profile). Give every existing
-- reseller an ONBOARDING profile so they start the checklist like a newly created one.
INSERT INTO "reseller_profiles" ("id", "companyId", "status", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, c."id", 'ONBOARDING', NOW(), NOW()
FROM "companies" c
LEFT JOIN "reseller_profiles" p ON p."companyId" = c."id"
WHERE c."relationshipType" = 'RESELLER' AND p."id" IS NULL;
