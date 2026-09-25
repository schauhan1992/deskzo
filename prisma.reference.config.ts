import "dotenv/config";
import { defineConfig } from "prisma/config";

/**
 * The shared reference database's Prisma config — prisma/reference/schema.prisma. Every Prisma
 * command for it names this file (`--config prisma.reference.config.ts`); the default
 * prisma.config.ts is the workspace schema, prisma.control.config.ts the control plane.
 */
export default defineConfig({
  schema: "prisma/reference/schema.prisma",
  migrations: {
    path: "prisma/reference/migrations",
  },
});
