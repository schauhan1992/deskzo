-- AlterTable
ALTER TABLE "contacts" ADD COLUMN     "contactSeq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "leadSeq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "userSeq" SERIAL NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "contacts_contactSeq_key" ON "contacts"("contactSeq");

-- CreateIndex
CREATE UNIQUE INDEX "leads_leadSeq_key" ON "leads"("leadSeq");

-- CreateIndex
CREATE UNIQUE INDEX "users_userSeq_key" ON "users"("userSeq");

