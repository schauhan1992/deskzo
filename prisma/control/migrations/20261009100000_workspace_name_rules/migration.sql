-- Workspace names: staff block names and words, release built-in ones, and hold an address for one
-- customer on an invitation.

-- CreateEnum
CREATE TYPE "NameRuleKind" AS ENUM ('BLOCK_EXACT', 'BLOCK_WORD', 'RELEASE');

-- AlterTable
ALTER TABLE "signup_invites" ADD COLUMN     "heldSlug" TEXT,
ADD COLUMN     "heldSlugSkipsReserved" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "workspace_name_rules" (
    "id" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "kind" "NameRuleKind" NOT NULL,
    "reason" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_name_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workspace_name_rules_kind_value_key" ON "workspace_name_rules"("kind", "value");

-- CreateIndex
CREATE UNIQUE INDEX "signup_invites_heldSlug_key" ON "signup_invites"("heldSlug");


-- Written by hand: values are stored the way they are compared — lower case, letters, digits and
-- hyphens (a word has no hyphen); reasons are given; a held address has a workspace address's shape.
ALTER TABLE "workspace_name_rules"
  ADD CONSTRAINT "workspace_name_rules_value_shape" CHECK (
    ("kind" = 'BLOCK_EXACT' AND "value" ~ '^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$')
    OR ("kind" <> 'BLOCK_EXACT' AND "value" ~ '^[a-z0-9]{2,40}$')
  ),
  ADD CONSTRAINT "workspace_name_rules_reason_present" CHECK (length(btrim("reason")) > 0 AND length("reason") <= 500);
ALTER TABLE "signup_invites"
  ADD CONSTRAINT "signup_invites_held_slug_shape" CHECK ("heldSlug" IS NULL OR "heldSlug" ~ '^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$'),
  ADD CONSTRAINT "signup_invites_skip_needs_held" CHECK (NOT "heldSlugSkipsReserved" OR "heldSlug" IS NOT NULL);
