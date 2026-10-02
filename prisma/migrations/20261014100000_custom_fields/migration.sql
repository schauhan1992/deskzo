-- Custom fields (owner, 2 Oct 2026): the workspace's own fields on companies, contacts, leads, orders and
-- products. Definitions in custom_field_definitions; values on each record, in its "customFields" JSON,
-- keyed by the definition's key. src/lib/custom-fields/rules.ts checks every value written by the app;
-- the CHECKs below hold the shape for anything else that writes here.
-- CreateEnum
CREATE TYPE "CustomFieldEntity" AS ENUM ('COMPANY', 'CONTACT', 'LEAD', 'ORDER', 'ITEM');

-- CreateEnum
CREATE TYPE "CustomFieldType" AS ENUM ('TEXT', 'LONG_TEXT', 'NUMBER', 'MONEY', 'DATE', 'SELECT', 'MULTI_SELECT', 'CHECKBOX', 'EMAIL', 'PHONE', 'URL', 'USER');

-- AlterTable
ALTER TABLE "companies" ADD COLUMN     "customFields" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "contacts" ADD COLUMN     "customFields" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "customFields" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "items" ADD COLUMN     "customFields" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "company_products" ADD COLUMN     "customFields" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "custom_field_definitions" (
    "id" TEXT NOT NULL,
    "entity" "CustomFieldEntity" NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" "CustomFieldType" NOT NULL,
    "options" JSONB NOT NULL DEFAULT '[]',
    "required" BOOLEAN NOT NULL DEFAULT false,
    "helpText" TEXT,
    "group" TEXT,
    "restricted" BOOLEAN NOT NULL DEFAULT false,
    "showInList" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_field_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "custom_field_definitions_entity_archivedAt_sortOrder_idx" ON "custom_field_definitions"("entity", "archivedAt", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "custom_field_definitions_entity_key_key" ON "custom_field_definitions"("entity", "key");

-- AddForeignKey
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- A record's values are always an object of key → value, never a list or a bare value.
ALTER TABLE "companies" ADD CONSTRAINT "companies_custom_fields_object" CHECK (jsonb_typeof("customFields") = 'object');
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_custom_fields_object" CHECK (jsonb_typeof("customFields") = 'object');
ALTER TABLE "leads" ADD CONSTRAINT "leads_custom_fields_object" CHECK (jsonb_typeof("customFields") = 'object');
ALTER TABLE "items" ADD CONSTRAINT "items_custom_fields_object" CHECK (jsonb_typeof("customFields") = 'object');
ALTER TABLE "company_products" ADD CONSTRAINT "company_products_custom_fields_object" CHECK (jsonb_typeof("customFields") = 'object');

-- The key is what every record's JSON is keyed by: lower case, a letter first, at most 40 characters.
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_key_shape" CHECK ("key" ~ '^[a-z][a-z0-9_]{0,39}$');
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_label_length" CHECK (char_length(btrim("label")) BETWEEN 1 AND 60);
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_help_length" CHECK ("helpText" IS NULL OR char_length("helpText") <= 200);
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_group_length" CHECK ("group" IS NULL OR char_length("group") <= 40);
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_options_list" CHECK (jsonb_typeof("options") = 'array' AND jsonb_array_length("options") <= 100);
