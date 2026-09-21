-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('PROPOSED', 'DISCOVERY', 'PLANNING', 'IN_PROGRESS', 'UAT', 'GO_LIVE', 'HANDOVER', 'COMPLETED', 'ON_HOLD', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ProjectHealth" AS ENUM ('ON_TRACK', 'AT_RISK', 'OFF_TRACK');

-- CreateEnum
CREATE TYPE "ProjectStakeholderRole" AS ENUM ('SPONSOR', 'PROJECT_MANAGER', 'TECHNICAL_LEAD', 'TEAM_MEMBER', 'CUSTOMER_SPONSOR', 'CUSTOMER_TECHNICAL', 'CUSTOMER_USER', 'VENDOR', 'OBSERVER');

-- CreateEnum
CREATE TYPE "ProjectDocumentType" AS ENUM ('AGREEMENT', 'NDA', 'SOW', 'PROPOSAL', 'DESIGN', 'SIGN_OFF', 'HANDOVER', 'REPORT', 'OTHER');

-- CreateEnum
CREATE TYPE "ProjectRiskKind" AS ENUM ('RISK', 'ISSUE');

-- CreateEnum
CREATE TYPE "ProjectRiskSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "ProjectRiskStatus" AS ENUM ('OPEN', 'MITIGATING', 'RESOLVED', 'ACCEPTED', 'CLOSED');

-- CreateEnum
CREATE TYPE "ProjectBillingStatus" AS ENUM ('PENDING', 'DUE', 'INVOICED', 'PAID', 'WAIVED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'PROJECT_CREDENTIAL_VIEWED';
ALTER TYPE "NotificationType" ADD VALUE 'PROJECT_STAKEHOLDER_ADDED';
ALTER TYPE "NotificationType" ADD VALUE 'PROJECT_STATUS_CHANGED';

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "projectId" TEXT;

-- CreateTable
CREATE TABLE "project_types" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_template_milestones" (
    "id" TEXT NOT NULL,
    "typeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "note" TEXT,
    "dayOffset" INTEGER NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "project_template_milestones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "typeId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "ProjectStatus" NOT NULL DEFAULT 'PROPOSED',
    "health" "ProjectHealth" NOT NULL DEFAULT 'ON_TRACK',
    "startDate" TIMESTAMP(3),
    "targetEndDate" TIMESTAMP(3),
    "actualEndDate" TIMESTAMP(3),
    "managerId" TEXT,
    "companyProductId" TEXT,
    "value" DECIMAL(14,2),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_stakeholders" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT,
    "contactId" TEXT,
    "role" "ProjectStakeholderRole" NOT NULL DEFAULT 'TEAM_MEMBER',
    "note" TEXT,
    "addedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_stakeholders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_documents" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "type" "ProjectDocumentType" NOT NULL DEFAULT 'OTHER',
    "name" TEXT NOT NULL,
    "note" TEXT,
    "fileDataUrl" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_credentials" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "username" TEXT,
    "url" TEXT,
    "note" TEXT,
    "secretCipher" TEXT NOT NULL,
    "rotatedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credential_reveals" (
    "id" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credential_reveals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_milestones" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "note" TEXT,
    "dueDate" TIMESTAMP(3),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "completedAt" TIMESTAMP(3),
    "completedById" TEXT,

    CONSTRAINT "project_milestones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_billing_milestones" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "percent" DECIMAL(5,2),
    "amount" DECIMAL(14,2) NOT NULL,
    "dueOn" TIMESTAMP(3),
    "status" "ProjectBillingStatus" NOT NULL DEFAULT 'PENDING',
    "documentId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "project_billing_milestones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_risks" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "kind" "ProjectRiskKind" NOT NULL DEFAULT 'RISK',
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "severity" "ProjectRiskSeverity" NOT NULL DEFAULT 'MEDIUM',
    "status" "ProjectRiskStatus" NOT NULL DEFAULT 'OPEN',
    "mitigation" TEXT,
    "ownerId" TEXT,
    "raisedById" TEXT,
    "raisedOn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedOn" TIMESTAMP(3),

    CONSTRAINT "project_risks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_updates" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "health" "ProjectHealth" NOT NULL DEFAULT 'ON_TRACK',
    "authorId" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_updates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "project_types_name_key" ON "project_types"("name");

-- CreateIndex
CREATE INDEX "project_template_milestones_typeId_idx" ON "project_template_milestones"("typeId");

-- CreateIndex
CREATE UNIQUE INDEX "projects_code_key" ON "projects"("code");

-- CreateIndex
CREATE INDEX "projects_companyId_idx" ON "projects"("companyId");

-- CreateIndex
CREATE INDEX "projects_managerId_idx" ON "projects"("managerId");

-- CreateIndex
CREATE INDEX "projects_status_idx" ON "projects"("status");

-- CreateIndex
CREATE INDEX "project_stakeholders_userId_idx" ON "project_stakeholders"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "project_stakeholders_projectId_userId_key" ON "project_stakeholders"("projectId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "project_stakeholders_projectId_contactId_key" ON "project_stakeholders"("projectId", "contactId");

-- CreateIndex
CREATE INDEX "project_documents_projectId_idx" ON "project_documents"("projectId");

-- CreateIndex
CREATE INDEX "project_credentials_projectId_idx" ON "project_credentials"("projectId");

-- CreateIndex
CREATE INDEX "credential_reveals_credentialId_idx" ON "credential_reveals"("credentialId");

-- CreateIndex
CREATE INDEX "credential_reveals_userId_idx" ON "credential_reveals"("userId");

-- CreateIndex
CREATE INDEX "project_milestones_projectId_idx" ON "project_milestones"("projectId");

-- CreateIndex
CREATE INDEX "project_billing_milestones_projectId_idx" ON "project_billing_milestones"("projectId");

-- CreateIndex
CREATE INDEX "project_risks_projectId_idx" ON "project_risks"("projectId");

-- CreateIndex
CREATE INDEX "project_updates_projectId_idx" ON "project_updates"("projectId");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_template_milestones" ADD CONSTRAINT "project_template_milestones_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "project_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "project_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_companyProductId_fkey" FOREIGN KEY ("companyProductId") REFERENCES "company_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_stakeholders" ADD CONSTRAINT "project_stakeholders_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_stakeholders" ADD CONSTRAINT "project_stakeholders_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_stakeholders" ADD CONSTRAINT "project_stakeholders_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_stakeholders" ADD CONSTRAINT "project_stakeholders_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_documents" ADD CONSTRAINT "project_documents_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_documents" ADD CONSTRAINT "project_documents_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_credentials" ADD CONSTRAINT "project_credentials_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_credentials" ADD CONSTRAINT "project_credentials_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credential_reveals" ADD CONSTRAINT "credential_reveals_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "project_credentials"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credential_reveals" ADD CONSTRAINT "credential_reveals_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_milestones" ADD CONSTRAINT "project_milestones_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_milestones" ADD CONSTRAINT "project_milestones_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_billing_milestones" ADD CONSTRAINT "project_billing_milestones_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_billing_milestones" ADD CONSTRAINT "project_billing_milestones_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "trade_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_risks" ADD CONSTRAINT "project_risks_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_risks" ADD CONSTRAINT "project_risks_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_risks" ADD CONSTRAINT "project_risks_raisedById_fkey" FOREIGN KEY ("raisedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_updates" ADD CONSTRAINT "project_updates_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_updates" ADD CONSTRAINT "project_updates_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
