-- AlterTable
ALTER TABLE "signature_templates" ADD COLUMN     "logoLink" TEXT;

-- CreateTable
CREATE TABLE "signature_banners" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "imageData" TEXT,
    "imageUrl" TEXT,
    "linkUrl" TEXT,
    "altText" TEXT NOT NULL,
    "width" INTEGER NOT NULL DEFAULT 500,
    "startsOn" DATE,
    "endsOn" DATE,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "templateIds" JSONB NOT NULL DEFAULT '[]',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "signature_banners_pkey" PRIMARY KEY ("id")
);

-- Written by hand: a banner has exactly one picture, a width a mail program can show, and never ends
-- before it starts. Its addresses are https only (checked by src/actions/signature.ts and again when drawn).
ALTER TABLE "signature_banners" ADD CONSTRAINT "signature_banners_one_picture" CHECK (("imageData" IS NULL) <> ("imageUrl" IS NULL));
ALTER TABLE "signature_banners" ADD CONSTRAINT "signature_banners_width" CHECK ("width" BETWEEN 120 AND 600);
ALTER TABLE "signature_banners" ADD CONSTRAINT "signature_banners_dates" CHECK ("startsOn" IS NULL OR "endsOn" IS NULL OR "endsOn" >= "startsOn");
