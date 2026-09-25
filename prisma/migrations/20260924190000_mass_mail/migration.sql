-- CreateEnum
CREATE TYPE "TemplateFormat" AS ENUM ('TEXT', 'HTML');

-- AlterTable
ALTER TABLE "marketing_campaigns" ADD COLUMN     "listId" TEXT,
ALTER COLUMN "audienceId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "marketing_messages" ADD COLUMN     "textBody" TEXT,
ADD COLUMN     "unsubscribeUrl" TEXT;

-- AlterTable
ALTER TABLE "marketing_templates" ADD COLUMN     "format" "TemplateFormat" NOT NULL DEFAULT 'TEXT',
ADD COLUMN     "sourceFileName" TEXT;

-- CreateTable
CREATE TABLE "marketing_assets" (
    "id" TEXT NOT NULL,
    "templateId" TEXT,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_lists" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fileName" TEXT,
    "consentNote" TEXT NOT NULL,
    "topics" "MarketingTopic"[],
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_lists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_list_members" (
    "listId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_list_members_pkey" PRIMARY KEY ("listId","contactId")
);

-- CreateIndex
CREATE INDEX "marketing_assets_templateId_idx" ON "marketing_assets"("templateId");

-- CreateIndex
CREATE INDEX "marketing_list_members_contactId_idx" ON "marketing_list_members"("contactId");

-- AddForeignKey
ALTER TABLE "marketing_campaigns" ADD CONSTRAINT "marketing_campaigns_listId_fkey" FOREIGN KEY ("listId") REFERENCES "marketing_lists"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_assets" ADD CONSTRAINT "marketing_assets_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "marketing_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_assets" ADD CONSTRAINT "marketing_assets_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_lists" ADD CONSTRAINT "marketing_lists_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_list_members" ADD CONSTRAINT "marketing_list_members_listId_fkey" FOREIGN KEY ("listId") REFERENCES "marketing_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_list_members" ADD CONSTRAINT "marketing_list_members_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
