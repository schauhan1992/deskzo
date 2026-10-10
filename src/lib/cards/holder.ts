import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { workspaceClock } from "@/lib/time/workspace";
import { notMigratedYet } from "@/lib/not-migrated";

/**
 * Whether a card is live — the one rule the menu, My card and the public page all use.
 *
 * Live is: switched on, its holder's account active and a member's, and their last working day not
 * yet behind them. Recording an exit is enough to darken the card the day after the last day, before
 * anybody switches the account off; the card's own switch is never touched, so a rehire is one click.
 *
 * `exitedOn` is a @db.Date, so the comparison is by calendar day: the card is live through the whole
 * of the last day, in the workspace's time zone.
 */
export function liveCardWhere(today: string): Prisma.DigitalCardWhereInput {
  return {
    status: "ACTIVE",
    user: {
      active: true,
      kind: "MEMBER",
      // Three cases rather than a NOT, which would drop everybody whose exit date is null.
      OR: [{ employeeProfile: { is: null } }, { employeeProfile: { is: { exitedOn: null } } }, { employeeProfile: { is: { exitedOn: { gte: new Date(`${today}T00:00:00.000Z`) } } } }],
    },
  };
}

/**
 * Whether this person is on the team of a card event that hasn't been over for more than a week — the
 * days its people can still be added. False in a workspace whose tables aren't there yet.
 */
export async function onEventTeam(userId: string): Promise<boolean> {
  try {
    const today = (await workspaceClock()).today();
    const weekAgo = new Date(Date.parse(`${today}T00:00:00Z`) - 7 * 86_400_000);
    const row = await db.cardCampaignMember.findFirst({ where: { userId, campaign: { endsOn: { gte: weekAgo } } }, select: { userId: true } });
    return row !== null;
  } catch (err) {
    if (notMigratedYet(err)) return false;
    throw err;
  }
}

/** Whether this person holds a live card. False, not an error, in a workspace whose tables aren't there yet. */
export async function holdsLiveCard(userId: string): Promise<boolean> {
  try {
    const today = (await workspaceClock()).today();
    const card = await db.digitalCard.findFirst({ where: { AND: [{ userId }, liveCardWhere(today)] }, select: { id: true } });
    return card !== null;
  } catch (err) {
    if (notMigratedYet(err)) return false;
    throw err;
  }
}
