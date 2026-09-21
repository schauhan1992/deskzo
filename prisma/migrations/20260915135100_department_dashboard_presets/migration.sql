-- AlterTable
ALTER TABLE "departments" ADD COLUMN     "defaultDashboardWidgets" TEXT[] DEFAULT ARRAY[]::TEXT[];
