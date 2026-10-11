-- AlterTable
ALTER TABLE "signature_banners" ADD COLUMN     "removedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "signature_settings" ADD COLUMN     "trackClicks" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "signature_clicks" (
    "kind" TEXT NOT NULL,
    "refId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "clicks" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "signature_clicks_pkey" PRIMARY KEY ("kind","refId","userId","day")
);

-- CreateIndex
CREATE INDEX "signature_clicks_day_idx" ON "signature_clicks"("day");

-- Written by hand: only the two kinds of thing a signature counts, and never a negative count.
ALTER TABLE "signature_clicks" ADD CONSTRAINT "signature_clicks_kind" CHECK ("kind" IN ('BANNER', 'BUTTON'));
ALTER TABLE "signature_clicks" ADD CONSTRAINT "signature_clicks_count" CHECK ("clicks" >= 0);
