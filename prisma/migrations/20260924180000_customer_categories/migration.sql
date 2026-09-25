-- AlterTable
ALTER TABLE "companies" ADD COLUMN     "customerCategoryId" TEXT;

-- CreateTable
CREATE TABLE "customer_categories" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" TEXT,
    "icon" TEXT,
    "color" TEXT,
    "guidance" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_categories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_categories_parentId_idx" ON "customer_categories"("parentId");

-- CreateIndex
CREATE INDEX "companies_customerCategoryId_idx" ON "companies"("customerCategoryId");

-- AddForeignKey
ALTER TABLE "companies" ADD CONSTRAINT "companies_customerCategoryId_fkey" FOREIGN KEY ("customerCategoryId") REFERENCES "customer_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_categories" ADD CONSTRAINT "customer_categories_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "customer_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A starter set, to rename, recolour or delete. Parents first, so each child's parent exists.
INSERT INTO "customer_categories" ("id", "name", "parentId", "icon", "color", "guidance", "sortOrder", "updatedAt") VALUES
('cc_strategic', 'Strategic', NULL, 'star', '#f59e0b', 'Our most important accounts. Senior people stay close, and every quote is checked before it goes.', 0, CURRENT_TIMESTAMP),
('cc_strategic_key', 'Key account', 'cc_strategic', 'crown', NULL, 'Reply within four hours. The account manager and their manager see every quote, ticket and renewal.', 0, CURRENT_TIMESTAMP),
('cc_strategic_growth', 'Growth account', 'cc_strategic', 'trending-up', NULL, 'Plan the next sale: review what they run every quarter and look for what is missing.', 1, CURRENT_TIMESTAMP),
('cc_enterprise', 'Enterprise', NULL, 'building', '#6366f1', 'Large, process-driven buyers. Expect purchase orders, vendor registration and longer approvals.', 1, CURRENT_TIMESTAMP),
('cc_enterprise_large', 'Large enterprise', 'cc_enterprise', NULL, NULL, 'Bring procurement in early and keep compliance papers ready.', 0, CURRENT_TIMESTAMP),
('cc_enterprise_mid', 'Mid-market', 'cc_enterprise', NULL, NULL, 'One or two people decide, so decisions are quicker. Keep proposals short.', 1, CURRENT_TIMESTAMP),
('cc_smb', 'SMB', NULL, 'store', '#10b981', 'Owner-led and price-aware. Keep it simple, quick and bundled.', 2, CURRENT_TIMESTAMP),
('cc_smb_small', 'Small business', 'cc_smb', NULL, NULL, 'Offer bundles and annual plans; advance payment by default.', 0, CURRENT_TIMESTAMP),
('cc_smb_startup', 'Startup', 'cc_smb', 'rocket', NULL, 'Growing fast: sell for where they will be in a year, and keep an eye on credit.', 1, CURRENT_TIMESTAMP),
('cc_government', 'Government', NULL, 'landmark', '#0ea5e9', 'Tenders, GeM and fixed procedures. Follow the paperwork to the letter, and expect payments to take time.', 3, CURRENT_TIMESTAMP),
('cc_government_central', 'Central', 'cc_government', NULL, NULL, NULL, 0, CURRENT_TIMESTAMP),
('cc_government_state', 'State', 'cc_government', NULL, NULL, NULL, 1, CURRENT_TIMESTAMP),
('cc_government_psu', 'PSU', 'cc_government', 'factory', NULL, 'Expect L1 pricing and long payment cycles.', 2, CURRENT_TIMESTAMP),
('cc_education', 'Education', NULL, 'graduation-cap', '#8b5cf6', 'Budgets follow the academic year, so plan renewals around it. Education pricing often applies.', 4, CURRENT_TIMESTAMP),
('cc_education_school', 'School', 'cc_education', 'school', NULL, NULL, 0, CURRENT_TIMESTAMP),
('cc_education_higher', 'College / University', 'cc_education', 'university', NULL, NULL, 1, CURRENT_TIMESTAMP),
('cc_healthcare', 'Healthcare', NULL, 'hospital', '#ef4444', 'Uptime matters more than price. Answer support fast, and plan changes out of hours.', 5, CURRENT_TIMESTAMP),
('cc_healthcare_hospital', 'Hospital', 'cc_healthcare', NULL, NULL, NULL, 0, CURRENT_TIMESTAMP),
('cc_healthcare_clinic', 'Clinic', 'cc_healthcare', 'stethoscope', NULL, NULL, 1, CURRENT_TIMESTAMP),
('cc_channel', 'Channel', NULL, 'handshake', '#14b8a6', 'Partners who sell for us. Never contact their customers directly.', 6, CURRENT_TIMESTAMP),
('cc_channel_reseller', 'Reseller', 'cc_channel', NULL, NULL, NULL, 0, CURRENT_TIMESTAMP),
('cc_channel_referral', 'Referral partner', 'cc_channel', NULL, NULL, 'Pay the referral commission on time; they notice.', 1, CURRENT_TIMESTAMP),
('cc_watch', 'Watch', NULL, 'alert', '#dc2626', 'Handle with care: check the account before promising anything.', 7, CURRENT_TIMESTAMP),
('cc_watch_slow_payer', 'Slow payer', 'cc_watch', 'hourglass', NULL, 'Advance or part-advance only. Check what is outstanding before accepting an order.', 0, CURRENT_TIMESTAMP),
('cc_watch_at_risk', 'At risk', 'cc_watch', NULL, NULL, 'Unhappy or drifting. Tell the account manager before anything else goes out.', 1, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
