import type { CompanyStage } from "@prisma/client";
import { Badge } from "@/components/ui/card";

/**
 * Where an account stands: prospect, lead, customer, disqualified.
 *
 * Shared by the company 360 and the lead page so the same account can't appear to be at two
 * different stages depending on which screen you opened it from.
 *
 * "Awaiting order" is a customer with nothing ordered yet — a real state worth separating, because
 * it reads as a won deal that nobody has actually punched in.
 */
export function CompanyStageBadge({
  stage,
  awaitingOrder = false,
}: {
  stage: CompanyStage;
  awaitingOrder?: boolean;
}) {
  const tone = awaitingOrder
    ? "amber"
    : stage === "CUSTOMER"
      ? "green"
      : stage === "LEAD"
        ? "blue"
        : stage === "DISQUALIFIED"
          ? "red"
          : "default";

  return <Badge tone={tone}>{awaitingOrder ? "Awaiting Order" : stage}</Badge>;
}
