-- Prices belong to plans, not to payment gateways (owner, 12 Oct 2026: "the prices should show even if
-- Razorpay is there or not — what if I want to use Cashfree or another gateway?"). A price is shown and
-- sold whether a gateway is connected or not; each gateway's copy of it — a Stripe price, a Razorpay
-- plan — is made the first time somebody pays that price there, for the keys then in use (test and
-- live keys are different accounts at the gateway). plan_prices.gateway and .externalId are no longer
-- written; they stay for one release, then go.

-- AlterTable
ALTER TABLE "plan_prices" ALTER COLUMN "gateway" DROP NOT NULL;

-- CreateTable
CREATE TABLE "gateway_prices" (
    "id" TEXT NOT NULL,
    "priceId" TEXT NOT NULL,
    "gateway" "BillingGateway" NOT NULL,
    "mode" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gateway_prices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "gateway_prices_externalId_key" ON "gateway_prices"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "gateway_prices_priceId_gateway_mode_key" ON "gateway_prices"("priceId", "gateway", "mode");

-- AddForeignKey
ALTER TABLE "gateway_prices" ADD CONSTRAINT "gateway_prices_priceId_fkey" FOREIGN KEY ("priceId") REFERENCES "plan_prices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A copy is made by a gateway that charges, for test or live keys.
ALTER TABLE "gateway_prices" ADD CONSTRAINT "gateway_prices_gateway_check" CHECK ("gateway" <> 'MANUAL');
ALTER TABLE "gateway_prices" ADD CONSTRAINT "gateway_prices_mode_check" CHECK ("mode" IN ('test', 'live', 'unknown'));

-- Every price already made at a gateway keeps its copy there. Which keys made it was never kept.
INSERT INTO "gateway_prices" ("id", "priceId", "gateway", "mode", "externalId", "createdAt")
SELECT 'gp_' || "id", "id", "gateway", 'unknown', "externalId", "createdAt"
FROM "plan_prices"
WHERE "externalId" IS NOT NULL AND "gateway" IS NOT NULL AND "gateway" <> 'MANUAL';
