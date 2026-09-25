-- Reference data moves to the shared reference database (prisma/reference/schema.prisma), one copy
-- for every workspace instead of one in each.
--
-- Refuses while any of it is still here, so a workspace that has not been moved loses nothing: run
-- `npm run reference:move` first, which copies it across, checks the copy and empties these tables.
-- A new workspace, or a check suite's scratch database, has nothing in them and goes straight through.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "post_offices")
     OR EXISTS (SELECT 1 FROM "geo_states")
     OR EXISTS (SELECT 1 FROM "geo_cities")
     OR EXISTS (SELECT 1 FROM "geo_postal_codes")
     OR EXISTS (SELECT 1 FROM "reference_datasets")
     OR EXISTS (SELECT 1 FROM "reference_syncs") THEN
    RAISE EXCEPTION 'Reference data is still in this workspace''s database. Run npm run reference:move first: it copies it to REFERENCE_DATABASE_URL, checks the copy, and empties these tables.';
  END IF;
END $$;

DROP TABLE "post_offices";
DROP TABLE "geo_states";
DROP TABLE "geo_cities";
DROP TABLE "geo_postal_codes";
DROP TABLE "reference_datasets";
DROP TABLE "reference_syncs";
