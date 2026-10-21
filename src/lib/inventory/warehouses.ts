import type { Prisma } from "@prisma/client";
import type { AccountsSettings } from "@/lib/accounts/settings";

type Tx = Prisma.TransactionClient;

/**
 * Where stock goes when nothing says otherwise (owner, 22 Oct 2026): the warehouse Accounts settings name, else
 * the one marked default, else the first open one — and, in a workspace that somehow has none, a main
 * warehouse made now so a receipt never fails for want of somewhere to put it.
 */
export async function defaultWarehouseId(tx: Tx, settings: Pick<AccountsSettings, "defaultWarehouseId">): Promise<string> {
  if (settings.defaultWarehouseId) {
    const named = await tx.warehouse.findFirst({ where: { id: settings.defaultWarehouseId, active: true }, select: { id: true } });
    if (named) return named.id;
  }
  const marked = await tx.warehouse.findFirst({ where: { isDefault: true, active: true }, select: { id: true } });
  if (marked) return marked.id;
  const first = await tx.warehouse.findFirst({ where: { active: true }, orderBy: { createdAt: "asc" }, select: { id: true } });
  if (first) return first.id;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('deskzo:main-warehouse'))`;
  const again = await tx.warehouse.findFirst({ where: { active: true }, orderBy: { createdAt: "asc" }, select: { id: true } });
  if (again) return again.id;
  const code = (await tx.warehouse.findUnique({ where: { code: "MAIN" }, select: { id: true } })) ? `MAIN-${Date.now().toString(36).toUpperCase()}` : "MAIN";
  const created = await tx.warehouse.create({ data: { code, name: "Main warehouse", isDefault: true }, select: { id: true } });
  return created.id;
}
