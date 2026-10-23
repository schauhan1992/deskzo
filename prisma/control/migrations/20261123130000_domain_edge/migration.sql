-- A workspace's own address on Cloudflare for SaaS (owner, 23 Oct 2026): its id there and what Cloudflare last said
-- about it, so Deskzo issues its HTTPS certificate through Cloudflare's API instead of by hand.

-- AlterTable
ALTER TABLE "tenant_domains" ADD COLUMN "edge" JSONB;
