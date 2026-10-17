import type { Prisma } from "@prisma/client";
import { emitEvents } from "@/lib/automate/events";

/**
 * Deskzo Automate's event for people (Phase 6): somebody joins the company — an account made, or a
 * candidate brought on. Called inside the transaction that makes them. The payload carries who they
 * are at work — name, role, designation, team, manager, joining date — never their personal details.
 */

/** The payload's parts, also what a test run starts from (src/lib/automate/samples.ts). */
export async function personFacts(tx: Prisma.TransactionClient, userId: string) {
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, role: true, departmentId: true, managerId: true, department: { select: { name: true } }, employeeProfile: { select: { designation: true, joinedOn: true } } },
  });
  if (!user) return null;
  return {
    person: {
      id: user.id,
      name: user.name,
      role: user.role,
      designation: user.employeeProfile?.designation ?? null,
      departmentId: user.departmentId,
      department: user.department?.name ?? null,
      managerId: user.managerId,
      joinedOn: user.employeeProfile?.joinedOn?.toISOString().slice(0, 10) ?? null,
    },
  };
}

export async function emitPersonJoined(tx: Prisma.TransactionClient, userId: string, actorUserId: string | null): Promise<void> {
  await emitEvents(tx, "person.joined", async () => {
    const payload = await personFacts(tx, userId);
    return payload && { type: "person.joined", recordType: "user", recordId: userId, payload, actorUserId };
  });
}
