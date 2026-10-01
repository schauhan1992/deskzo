-- AlterTable
ALTER TABLE "payment_allocations" ADD COLUMN     "exchangeRate" DECIMAL(14,6),
ADD COLUMN     "paymentAmount" DECIMAL(12,2);

-- Written by hand: a cross-currency allocation carries both figures and a positive rate; others carry neither.
ALTER TABLE "payment_allocations"
  ADD CONSTRAINT "payment_allocations_cross_currency_pair" CHECK (("paymentAmount" IS NULL) = ("exchangeRate" IS NULL)),
  ADD CONSTRAINT "payment_allocations_rate_positive" CHECK ("exchangeRate" IS NULL OR "exchangeRate" > 0),
  ADD CONSTRAINT "payment_allocations_payment_amount_positive" CHECK ("paymentAmount" IS NULL OR "paymentAmount" > 0);
