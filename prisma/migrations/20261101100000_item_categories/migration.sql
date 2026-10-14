-- Item categories become a list the workspace keeps (Items › Categories), and "Perpetual licence"
-- stops being an item type: such an item is a service in that category.

-- CreateTable
CREATE TABLE "item_categories" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "item_categories_pkey" PRIMARY KEY ("id"),
    -- A name is something: trimmed, and not blank (the actions collapse inner spaces too).
    CONSTRAINT "item_categories_name_not_blank" CHECK ("name" = btrim("name") AND "name" <> '')
);

-- CreateIndex
CREATE UNIQUE INDEX "item_categories_name_key" ON "item_categories"("name");

-- Every category the catalogue already uses, once each however it was typed: case and runs of spaces
-- don't make a different category, so "laptops", "Laptops" and " Laptops " are one, spelled as the
-- first of them in alphabetical order.
INSERT INTO "item_categories" ("id", "name", "updatedAt")
SELECT gen_random_uuid()::text, "name", CURRENT_TIMESTAMP
FROM (
    SELECT DISTINCT ON (lower("spelled")) "spelled" AS "name"
    FROM (SELECT regexp_replace(btrim("category"), '\s+', ' ', 'g') AS "spelled" FROM "items" WHERE "category" IS NOT NULL) AS "typed"
    WHERE "spelled" <> ''
    ORDER BY lower("spelled"), "spelled"
) AS "names";

-- Each item now carries its category as the list spells it; a blank one is no category.
UPDATE "items" AS "i"
SET "category" = "c"."name"
FROM "item_categories" AS "c"
WHERE "i"."category" IS NOT NULL
  AND lower(regexp_replace(btrim("i"."category"), '\s+', ' ', 'g')) = lower("c"."name");
UPDATE "items" SET "category" = NULL WHERE "category" IS NOT NULL AND btrim("category") = '';

-- "Perpetual licence" is a category every workspace starts with.
INSERT INTO "item_categories" ("id", "name", "updatedAt")
SELECT gen_random_uuid()::text, 'Perpetual licence', CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "item_categories" WHERE lower("name") = 'perpetual licence');

-- A perpetual licence is a service in that category — unless somebody already gave it a category of
-- their own, which is kept. It behaved as a service everywhere already (no expiry, out of Renewals,
-- revenue at a point in time).
UPDATE "items"
SET "category" = (SELECT "name" FROM "item_categories" WHERE lower("name") = 'perpetual licence' LIMIT 1)
WHERE "type" = 'PERPETUAL' AND "category" IS NULL;
UPDATE "items" SET "type" = 'SERVICE' WHERE "type" = 'PERPETUAL';
