import { db } from "@/lib/db";
import type { Exporter } from "./types";

/**
 * Accounts, roles and the reporting line.
 *
 * Never the password hash and never the two-factor secret: neither has a legitimate export, and a
 * target system issues its own credentials. `entities.ts` marks both `sensitivity: "never"`, and the
 * absence here is the enforcement of it.
 *
 * The manager column is the reporting line, which is what every scoped view resolves against. It
 * travels by name, so a bundle can be loaded in any order.
 */
export const usersExporter: Exporter = async () => {
  const rows = await db.user.findMany({
    include: { department: { select: { name: true } }, manager: { select: { name: true } } },
    orderBy: { userSeq: "asc" },
  });
  return rows.map((u) => ({
    Key: `USR-${String(u.userSeq).padStart(6, "0")}`,
    Name: u.name,
    Email: u.email,
    Role: u.role,
    "Super admin": u.isSuperAdmin,
    Active: u.active,
    Department: u.department?.name ?? "",
    Manager: u.manager?.name ?? "",
  }));
};
