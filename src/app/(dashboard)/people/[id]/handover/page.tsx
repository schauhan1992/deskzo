import Link from "next/link";
import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { getPerson } from "@/actions/hr";
import { handoverInventory } from "@/actions/handover";
import { HandoverPlanner } from "@/components/people/handover-planner";
import { Card, CardContent } from "@/components/ui/card";
import { personPath } from "@/lib/record-links";

/**
 * Moving one person's live work to colleagues.
 *
 * Its own page rather than a dialog on the employee record: this is a decision about a dozen areas
 * at once, and the counts are the thing being read. It is also deliberately not behind the exit
 * flow — the same job comes up for a long absence, a change of territory, or maternity cover, and
 * a handover only reachable through "record an exit" is one nobody runs until somebody resigns.
 */
export default async function HandoverPage({ params }: { params: Promise<{ id: string }> }) {
  // Gated like its siblings under /people. Without this the link disappears with the module but
  // the URL keeps working, which is the sort of gap nobody finds until somebody bookmarks it.
  if (!(await isModuleEnabled("hr"))) return <ModuleDisabledNotice moduleKey="hr" />;

  const { id } = await params;
  const [person, inventory] = await Promise.all([getPerson(id), handoverInventory(id)]);
  if (!person) notFound();

  return (
    <div className="animate-fade-rise">
      <Link href={personPath(person.userSeq)} className="text-sm text-muted hover:text-text">
        ← {person.name}
      </Link>

      <h1 className="mt-2 text-xl font-semibold text-text">Hand over {person.name}&apos;s work</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        Moves live work only — the accounts they run, the tickets queued to them, the quotes with their name on.
        It never changes who created, approved or was paid for anything, and never touches their own attendance,
        leave or pay records.
      </p>

      <div className="mt-5">
        {inventory.ok ? (
          <HandoverPlanner
            fromUserId={id}
            fromName={person.name}
            areas={inventory.data.areas}
            people={inventory.data.people}
          />
        ) : (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted">{inventory.error}</CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
