-- Stored links to a record open its readable address (owner, 3 Oct 2026).
--
-- The app now links to /companies/COM-000123 rather than /companies/<cuid> (src/lib/record-links.ts).
-- A cuid link still opens the record, but by redirecting, and Next fetches a redirected page twice. The
-- links already written into rows were made the old way. Those are notifications, and the month-end
-- close's tie-out snapshots, which carry their items' links in JSON. They are rewritten here so that
-- opening them is as quick as any other.
--
-- Only a link to a record's own page changes, and only when that record still exists. /edit, /handover
-- and /settlement take the cuid, so a cuid followed by "/" is left alone. A link to a record since
-- deleted keeps its cuid; it opens "not found" either way. A link has to start the value (a notification)
-- or a JSON string (a snapshot), so another site's address that happens to contain a cuid is left alone.
-- The activity log's visited paths are history, not links, and are not touched. Running it again
-- changes nothing.

CREATE FUNCTION deskzo_readable_record_links(input TEXT) RETURNS TEXT AS $$
DECLARE
  hit TEXT[];
  ref TEXT;
  result TEXT := input;
BEGIN
  FOR hit IN
    SELECT DISTINCT regexp_matches(input, '(?:^|")/(companies|leads|items|orders|people|tickets|visits|expenses)/(c[a-z0-9]{20,})(?=[?#"]|$)', 'g')
  LOOP
    ref := CASE hit[1]
      WHEN 'companies' THEN (SELECT 'COM-'  || lpad("companySeq"::TEXT, 6, '0') FROM "companies"        WHERE "id" = hit[2])
      WHEN 'leads'     THEN (SELECT 'LEAD-' || lpad("leadSeq"::TEXT, 6, '0')    FROM "leads"            WHERE "id" = hit[2])
      WHEN 'items'     THEN (SELECT 'ITM-'  || lpad("itemSeq"::TEXT, 6, '0')    FROM "items"            WHERE "id" = hit[2])
      WHEN 'orders'    THEN (SELECT 'ORD-'  || lpad("orderSeq"::TEXT, 6, '0')   FROM "company_products" WHERE "id" = hit[2])
      WHEN 'people'    THEN (SELECT 'USR-'  || lpad("userSeq"::TEXT, 6, '0')    FROM "users"            WHERE "id" = hit[2])
      WHEN 'tickets'   THEN (SELECT 'TCK-'  || lpad("ticketSeq"::TEXT, 6, '0')  FROM "tickets"          WHERE "id" = hit[2])
      WHEN 'visits'    THEN (SELECT 'VIS-'  || lpad("visitSeq"::TEXT, 6, '0')   FROM "visits"           WHERE "id" = hit[2])
      WHEN 'expenses'  THEN (SELECT 'EXP-'  || lpad("expenseSeq"::TEXT, 6, '0') FROM "expenses"         WHERE "id" = hit[2])
    END;
    IF ref IS NOT NULL THEN
      result := regexp_replace(result, '(^|")/' || hit[1] || '/' || hit[2] || '(?=[?#"]|$)', '\1/' || hit[1] || '/' || ref, 'g');
    END IF;
  END LOOP;
  RETURN result;
END;
$$ LANGUAGE plpgsql;

UPDATE "notifications"
SET "link" = deskzo_readable_record_links("link")
WHERE "link" ~ '^/(companies|leads|items|orders|people|tickets|visits|expenses)/c[a-z0-9]{20,}(?=[?#]|$)';

UPDATE "close_tasks"
SET "autoDetail" = deskzo_readable_record_links("autoDetail"::TEXT)::JSONB
WHERE "autoDetail"::TEXT ~ '"/(companies|leads|items|orders|people|tickets|visits|expenses)/c[a-z0-9]{20,}(?=[?#"]|$)';

DROP FUNCTION deskzo_readable_record_links(TEXT);
