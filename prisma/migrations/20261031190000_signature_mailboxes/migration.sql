-- CreateTable
CREATE TABLE "signature_mailboxes" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "templateId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "signature_mailboxes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "signature_mailboxes_address_key" ON "signature_mailboxes"("address");

-- Written by hand: an address is kept lower-case, so the same mailbox can't be listed twice by its case.
ALTER TABLE "signature_mailboxes" ADD CONSTRAINT "signature_mailboxes_address_lower" CHECK ("address" = lower("address"));
