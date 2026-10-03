import Link from "next/link";
import type { listPeople } from "@/actions/hr";
import { Badge, Card } from "@/components/ui/card";
import { toKey } from "@/lib/hr/calendar";
import { workspaceClock } from "@/lib/time/workspace";
import { formatCalendarDay } from "@/lib/time/zone";
import { employmentTypeLabels, exitTypeLabels } from "@/lib/validation/hr";
import { personPath } from "@/lib/record-links";

type Row = Awaited<ReturnType<typeof listPeople>>[number];

/**
 * The staff directory.
 *
 * Deliberately thin: name, role, team, who they report to, and when they joined. Everything
 * sensitive — address, bank, date of birth — lives one click away on the record itself, so a
 * directory left open on a shared screen does not leak anybody's personal details.
 */
export async function PeopleTable({ people }: { people: Row[] }) {
  if (people.length === 0) {
    return (
      <Card className="px-4 py-12 text-center text-sm text-subtle">
        Nobody matches this filter.
      </Card>
    );
  }

  // Probation runs to the end of its last day in the workspace. Against the moment now it ended at
  // midnight UTC — 05:30 on that day in India.
  const today = (await workspaceClock()).today();

  return (
    <Card className="overflow-hidden p-0">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2.5">Name</th>
              <th className="px-4 py-2.5">Code</th>
              <th className="px-4 py-2.5">Designation</th>
              <th className="px-4 py-2.5">Team</th>
              <th className="px-4 py-2.5">Reports to</th>
              <th className="px-4 py-2.5">Type</th>
              <th className="px-4 py-2.5">Joined</th>
              <th className="px-4 py-2.5">Status</th>
            </tr>
          </thead>
          <tbody>
            {people.map((p) => {
              const profile = p.employeeProfile;
              const onProbation =
                profile?.probationEndsOn && !profile.confirmedOn && toKey(profile.probationEndsOn) >= today;
              return (
                <tr key={p.id} className="border-b border-line last:border-0 hover:bg-surface-sunken">
                  <td className="px-4 py-2.5">
                    <Link href={personPath(p.userSeq)} className="font-medium text-text hover:underline">
                      {p.name}
                    </Link>
                    <div className="text-xs text-subtle">{p.email}</div>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs text-muted">{profile?.employeeCode ?? "—"}</td>
                  <td className="px-4 py-2.5 text-muted">{profile?.designation ?? p.role}</td>
                  <td className="px-4 py-2.5 text-muted">{p.department?.name ?? "—"}</td>
                  <td className="px-4 py-2.5 text-muted">{p.manager?.name ?? "—"}</td>
                  <td className="px-4 py-2.5 text-muted">
                    {profile ? employmentTypeLabels[profile.employmentType] : "—"}
                  </td>
                  <td className="px-4 py-2.5 text-muted">
                    {profile?.joinedOn ? formatCalendarDay(profile.joinedOn) : "—"}
                  </td>
                  <td className="px-4 py-2.5">
                    {profile?.exitedOn ? (
                      <Badge tone="red">
                        {profile.exitType ? exitTypeLabels[profile.exitType] : "Exited"} {formatCalendarDay(profile.exitedOn)}
                      </Badge>
                    ) : onProbation ? (
                      <Badge tone="amber">Probation to {formatCalendarDay(profile!.probationEndsOn)}</Badge>
                    ) : p.active ? (
                      <Badge tone="green">Active</Badge>
                    ) : (
                      <Badge tone="default">Inactive</Badge>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
