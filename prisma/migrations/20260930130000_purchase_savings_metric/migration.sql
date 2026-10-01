-- ORD-HANDOFF: a target can be set on what purchase saved against the salesperson's distributor price
-- (the sum of PurchaseSaving.amount for the purchaser, by the Indian day it was recorded; measured in
-- src/lib/targets/measure.ts, defined in src/lib/targets/metrics.ts).
-- AlterEnum
ALTER TYPE "TargetMetric" ADD VALUE 'PURCHASE_SAVINGS';
