-- Claim stamp so two concurrent generate requests cannot both call the portal.
-- See the `generatingAt` doc comment on model EwayBill.
ALTER TABLE "eway_bills" ADD COLUMN "generatingAt" TIMESTAMP(3);
