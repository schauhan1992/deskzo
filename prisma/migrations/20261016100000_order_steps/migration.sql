-- A workspace's own steps within an order status (Settings → Pipeline, src/lib/pipeline/order-steps.ts).
--
-- The statuses and the process behind them stay the app's; a step says where within one an order has got
-- to. None are seeded: a workspace adds its own, and an order with no step shows none. The moves are kept
-- with the steps' names as they were, so the history still reads right after a rename.

-- AlterTable
ALTER TABLE "company_products" ADD COLUMN     "stepChangedAt" TIMESTAMP(3),
ADD COLUMN     "stepId" TEXT;

-- CreateTable
CREATE TABLE "order_steps" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "status" "OrderStatus" NOT NULL,
    "color" TEXT NOT NULL DEFAULT 'default',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_step_changes" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "fromStepId" TEXT,
    "fromLabel" TEXT,
    "toStepId" TEXT,
    "toLabel" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_step_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "order_steps_key_key" ON "order_steps"("key");

-- CreateIndex
CREATE INDEX "order_steps_status_archivedAt_sortOrder_idx" ON "order_steps"("status", "archivedAt", "sortOrder");

-- CreateIndex
CREATE INDEX "order_step_changes_orderId_createdAt_idx" ON "order_step_changes"("orderId", "createdAt");

-- CreateIndex
CREATE INDEX "company_products_stepId_idx" ON "company_products"("stepId");

-- AddForeignKey
ALTER TABLE "company_products" ADD CONSTRAINT "company_products_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "order_steps"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_step_changes" ADD CONSTRAINT "order_step_changes_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "company_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_step_changes" ADD CONSTRAINT "order_step_changes_fromStepId_fkey" FOREIGN KEY ("fromStepId") REFERENCES "order_steps"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_step_changes" ADD CONSTRAINT "order_step_changes_toStepId_fkey" FOREIGN KEY ("toStepId") REFERENCES "order_steps"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_step_changes" ADD CONSTRAINT "order_step_changes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- What a step may be: a key like a custom field's, a name that fits, a known colour, and only within the
-- statuses an order works through after approval.
ALTER TABLE "order_steps" ADD CONSTRAINT "order_steps_key_shape" CHECK ("key" ~ '^[a-z][a-z0-9_]{0,39}$');
ALTER TABLE "order_steps" ADD CONSTRAINT "order_steps_label_length" CHECK (char_length(btrim("label")) BETWEEN 1 AND 40);
ALTER TABLE "order_steps" ADD CONSTRAINT "order_steps_color_known" CHECK ("color" IN ('default', 'blue', 'amber', 'brand', 'green', 'red'));
ALTER TABLE "order_steps" ADD CONSTRAINT "order_steps_status_allowed" CHECK ("status" IN ('APPROVED', 'PROCESSING', 'FULFILLED'));
