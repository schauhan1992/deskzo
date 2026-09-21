-- CreateTable
CREATE TABLE "branding_settings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "appName" TEXT NOT NULL DEFAULT 'Wroffy ERP',
    "shortName" TEXT,
    "tagline" TEXT,
    "logoDataUrl" TEXT,
    "faviconDataUrl" TEXT,
    "primaryColor" TEXT NOT NULL DEFAULT '#4f46e5',
    "defaultTheme" TEXT NOT NULL DEFAULT 'system',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "branding_settings_pkey" PRIMARY KEY ("id")
);
