-- Deskzo Automate, Phase 4: a workflow's webhook address may take only calls signed with its secret.

-- AlterTable
ALTER TABLE "automation_webhooks" ADD COLUMN     "requireSignature" BOOLEAN NOT NULL DEFAULT false;

