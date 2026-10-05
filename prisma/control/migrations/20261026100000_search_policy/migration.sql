-- Search & AI (owner, 5 Oct 2026): the CMS keeps what crawlers may do on the public site as one
-- setting (src/lib/cms/search-policy.ts) — switches and llms.txt's summary of up to 500 characters, as
-- JSON. The 200 characters cms_settings allowed were for one word ("required"); 2,000 holds it.
ALTER TABLE "cms_settings" DROP CONSTRAINT "cms_settings_value_length";
ALTER TABLE "cms_settings" ADD CONSTRAINT "cms_settings_value_length" CHECK (char_length("value") <= 2000);
