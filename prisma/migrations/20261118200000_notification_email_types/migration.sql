-- Which notifications the workspace emails, chosen by an admin for everyone (18 Oct 2026). Empty means
-- the defaults: a proforma issued on your deal and AI credits running low, as before.
CREATE TABLE "notification_email_types" (
    "type" "NotificationType" NOT NULL,
    "email" BOOLEAN NOT NULL,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_email_types_pkey" PRIMARY KEY ("type")
);
