-- The industries every workspace starts with (owner, 8 Oct 2026; src/lib/companies/standard-industries.ts):
-- added to every workspace, existing and new, skipping any name it already has whatever its capitals.
-- A workspace's own industries are kept; admins still add, rename and remove them.
INSERT INTO "industries" ("id", "name", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, v.name, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (VALUES
  ('Agriculture'),
  ('Automotive'),
  ('Aviation'),
  ('BFSI'),
  ('Biotechnology'),
  ('Chemicals'),
  ('Construction'),
  ('Consulting'),
  ('Consumer Electronics'),
  ('Defence'),
  ('E-commerce'),
  ('Education'),
  ('Energy & Power'),
  ('Engineering'),
  ('FMCG'),
  ('Food & Beverages'),
  ('Gems & Jewellery'),
  ('Government'),
  ('Healthcare'),
  ('Hospitality'),
  ('IT Services'),
  ('Legal'),
  ('Logistics'),
  ('Manufacturing'),
  ('Media'),
  ('Metals & Mining'),
  ('NGO'),
  ('Oil & Gas'),
  ('Pharmaceuticals'),
  ('Professional Services'),
  ('Real Estate'),
  ('Retail'),
  ('Software'),
  ('Telecom'),
  ('Textiles'),
  ('Trading & Distribution'),
  ('Transportation'),
  ('Travel & Tourism'),
  ('Utilities'),
  ('Other')
) AS v(name)
WHERE NOT EXISTS (SELECT 1 FROM "industries" i WHERE lower(i."name") = lower(v.name));
