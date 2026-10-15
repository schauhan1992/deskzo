-- CreateTable
CREATE TABLE "document_mail_settings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "sendFrom" TEXT NOT NULL DEFAULT 'OWN',
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_mail_settings_pkey" PRIMARY KEY ("id")
);

