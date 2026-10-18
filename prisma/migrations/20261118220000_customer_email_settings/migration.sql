-- Settings › Customer emails (18 Oct 2026): the switches for what's emailed to customers on its own. Empty means
-- the defaults: a booking page emails the guest an invitation, as before.
CREATE TABLE "customer_email_settings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "bookingInvite" BOOLEAN NOT NULL DEFAULT true,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_email_settings_pkey" PRIMARY KEY ("id")
);
