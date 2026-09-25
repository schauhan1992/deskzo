import "dotenv/config";
import { defineConfig } from "prisma/config";

/**
 * The control plane's Prisma config — prisma/control/schema.prisma. Every Prisma command for it
 * names this file (`--config prisma.control.config.ts`); the default prisma.config.ts is the
 * workspace schema.
 */
export default defineConfig({
  schema: "prisma/control/schema.prisma",
  migrations: {
    path: "prisma/control/migrations",
  },
});
