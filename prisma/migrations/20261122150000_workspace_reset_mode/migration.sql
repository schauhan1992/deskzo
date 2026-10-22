-- "Keep my setup" (owner, 22 Oct 2026): which kind of reset was asked for.
CREATE TYPE "WorkspaceResetMode" AS ENUM ('EVERYTHING', 'KEEP_SETUP');

ALTER TABLE "workspace_resets" ADD COLUMN "mode" "WorkspaceResetMode" NOT NULL DEFAULT 'EVERYTHING';
