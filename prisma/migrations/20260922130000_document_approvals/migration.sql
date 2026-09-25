-- CreateEnum
CREATE TYPE "DocumentApprovalStatus" AS ENUM ('NOT_SUBMITTED', 'PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "trade_documents" ADD COLUMN     "approvalNote" TEXT,
ADD COLUMN     "approvalStatus" "DocumentApprovalStatus" NOT NULL DEFAULT 'NOT_SUBMITTED',
ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedById" TEXT,
ADD COLUMN     "submittedAt" TIMESTAMP(3),
ADD COLUMN     "submittedById" TEXT;

-- CreateTable
CREATE TABLE "document_approval_policies" (
    "docType" "TradeDocumentType" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "approverRoles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "managerApproves" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "document_approval_policies_pkey" PRIMARY KEY ("docType")
);

-- CreateTable
CREATE TABLE "_DocumentApprover" (
    "A" "TradeDocumentType" NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_DocumentApprover_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "_DocumentApprover_B_index" ON "_DocumentApprover"("B");

-- AddForeignKey
ALTER TABLE "trade_documents" ADD CONSTRAINT "trade_documents_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_documents" ADD CONSTRAINT "trade_documents_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_approval_policies" ADD CONSTRAINT "document_approval_policies_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_DocumentApprover" ADD CONSTRAINT "_DocumentApprover_A_fkey" FOREIGN KEY ("A") REFERENCES "document_approval_policies"("docType") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_DocumentApprover" ADD CONSTRAINT "_DocumentApprover_B_fkey" FOREIGN KEY ("B") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
