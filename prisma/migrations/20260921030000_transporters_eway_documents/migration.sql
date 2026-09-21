-- CreateTable
CREATE TABLE "transporters" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "gstin" TEXT,
    "contactName" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "defaultMode" "TransportMode" NOT NULL DEFAULT 'ROAD',
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,

    CONSTRAINT "transporters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eway_bills" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "declaredValue" DECIMAL(14,2) NOT NULL,
    "interstate" BOOLEAN NOT NULL DEFAULT false,
    "distanceKm" INTEGER NOT NULL,
    "transporterId" TEXT,
    "transportMode" "TransportMode" NOT NULL DEFAULT 'ROAD',
    "vehicleType" "VehicleType" NOT NULL DEFAULT 'REGULAR',
    "vehicleNumber" TEXT,
    "transportDocNumber" TEXT,
    "transportDocDate" TIMESTAMP(3),
    "status" "EwayBillStatus" NOT NULL DEFAULT 'REQUIRED',
    "ewayBillNumber" TEXT,
    "ewayBillDate" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "error" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "associated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,

    CONSTRAINT "eway_bills_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "transporters_active_name_idx" ON "transporters"("active", "name");
CREATE INDEX "eway_bills_documentId_idx" ON "eway_bills"("documentId");
CREATE INDEX "eway_bills_status_createdAt_idx" ON "eway_bills"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "transporters" ADD CONSTRAINT "transporters_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "eway_bills" ADD CONSTRAINT "eway_bills_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "trade_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "eway_bills" ADD CONSTRAINT "eway_bills_transporterId_fkey" FOREIGN KEY ("transporterId") REFERENCES "transporters"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Every distinct courier already typed on a consignment becomes a transporter, so nothing that has
-- been recorded is lost when the free-text column stops being the source of truth.
INSERT INTO "transporters" ("id", "name", "updatedAt", "notes")
SELECT
  md5(random()::text || clock_timestamp()::text),
  TRIM(c."courier"),
  CURRENT_TIMESTAMP,
  'Created from a courier name already on a consignment.'
FROM (SELECT DISTINCT TRIM("courier") AS "courier" FROM "consignments" WHERE "courier" IS NOT NULL AND TRIM("courier") <> '') c;

-- AlterTable: point consignments at the transporter row that matches what was typed on them.
ALTER TABLE "consignments" ADD COLUMN "transporterId_new" TEXT;
UPDATE "consignments" c SET "transporterId_new" = t."id"
  FROM "transporters" t WHERE TRIM(c."courier") = t."name";

-- The e-way columns added to consignments now live on eway_bills instead.
ALTER TABLE "consignments"
  DROP COLUMN "transporterId",
  DROP COLUMN "transporterName",
  DROP COLUMN "transportMode",
  DROP COLUMN "vehicleType",
  DROP COLUMN "distanceKm",
  DROP COLUMN "ewayBillStatus",
  DROP COLUMN "ewayBillDate",
  DROP COLUMN "ewayBillError",
  DROP COLUMN "ewayBillCancelledAt",
  DROP COLUMN "ewayBillCancelReason";

ALTER TABLE "consignments" RENAME COLUMN "transporterId_new" TO "transporterId";
ALTER TABLE "consignments" ADD CONSTRAINT "consignments_transporterId_fkey" FOREIGN KEY ("transporterId") REFERENCES "transporters"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Threshold configuration, so a business can raise the floor for its own intra-state movement.
ALTER TABLE "organisation_settings" ADD COLUMN "ewayIntraStateThreshold" DECIMAL(12,2);
