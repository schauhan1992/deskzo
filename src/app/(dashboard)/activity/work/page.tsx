import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { activityPeopleOptions } from "@/actions/activity-feed";
import { activityGroupsFor, mayViewPersonActivity, personActivity } from "@/lib/activity/timeline";
import { workspaceClock } from "@/lib/time/workspace";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { ActivityFeed } from "@/components/activity/activity-feed";

/**
 * Everything one person did (owner, 19 Oct 2026 — src/lib/activity/timeline.ts): the records they added
 * and changed, their calls, notes and emails, their sign-ins. Anybody sees their own; a manager their
 * team's; `activity.viewAll` everyone's. Somebody else's, out of reach, is a 404 like any refused page.
 */
export default async function WorkActivityPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const asked = Array.isArray(params.person) ? params.person[0] : params.person;

  const user = await requireUser();
  const personId = asked || user.id;
  if (!(await mayViewPersonActivity(user.id, personId))) notFound();

  const [people, page, groups, clock] = await Promise.all([activityPeopleOptions(), personActivity(user.id, personId), activityGroupsFor(user.id, "person", personId), workspaceClock()]);
  const others = people.filter((p) => p.id !== user.id);
  const name = personId === user.id ? null : (people.find((p) => p.id === personId)?.name ?? null);

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text">Work activity</h1>
          <p className="mt-1 text-sm text-muted">
            {name ? `Everything ${name} did` : "Everything you did"} — records added and changed, calls, notes, emails and sign-ins, newest first.
          </p>
        </div>
        <Link href="/activity" className="text-sm text-muted underline-offset-2 hover:text-text hover:underline">
          Security log
        </Link>
      </div>

      {others.length > 0 && (
        <div className="mt-4">
          <SelectParamFilter paramName="person" label="Whose" allLabel="Mine" options={others.map((p) => ({ value: p.id, label: p.name }))} />
        </div>
      )}

      <div className="mt-4">
        {/* Keyed to the person, so choosing somebody else starts their feed afresh. */}
        <ActivityFeed key={personId} source={{ kind: "person", id: personId }} initial={page} groups={groups} zone={clock.zone} />
      </div>
    </div>
  );
}
