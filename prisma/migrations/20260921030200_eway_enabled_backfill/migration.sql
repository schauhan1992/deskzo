-- `ewayEnabled` defaults to false, but e-way bills were not previously behind a switch of their
-- own: anyone with e-invoicing configured could already raise one. Defaulting them to off would
-- silently stop a compliance module that was working the day before, so the new flag inherits the
-- answer that was true until now.
UPDATE "organisation_settings" SET "ewayEnabled" = "einvoiceEnabled";
