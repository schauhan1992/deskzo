-- The phone's own secret, apart from its device row's token (src/lib/app/web-session.ts).
ALTER TABLE "app_devices" ADD COLUMN "secretDigest" TEXT;
