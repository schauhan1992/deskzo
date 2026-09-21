-- AlterTable
ALTER TABLE "users" ADD COLUMN     "dashboardCustomized" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "dashboardWidgets" TEXT[] DEFAULT ARRAY[]::TEXT[];
