import Link from "next/link";
import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { hasEffectivePermission } from "@/actions/permission";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { requireUser } from "@/lib/session";
import { workspaceClock } from "@/lib/time/workspace";
import { teamChoices } from "@/lib/cards/events-server";
import { Card } from "@/components/ui/card";
import { EventEditor } from "@/components/cards/event-editor";

/** A new card event — for whoever manages cards. */
export default async function NewCardEventPage() {
  if (!(await isModuleEnabled("cards"))) return <ModuleDisabledNotice moduleKey="cards" />;
  const me = await requireUser();
  if (!(await hasEffectivePermission(me.id, "cards.manage"))) notFound();
  const [people, today] = await Promise.all([teamChoices(), workspaceClock().then((c) => c.today())]);

  return (
    <div className="animate-fade-rise space-y-4">
      <div>
        <Link href="/cards/events" className="text-sm text-muted hover:text-text">
          ← Card events
        </Link>
        <h1 className="mt-2 text-xl font-semibold text-text">New event</h1>
      </div>
      <Card className="p-5">
        <EventEditor
          initial={{ id: null, name: "", venue: "", startsOn: today, endsOn: today, goal: "", cost: "", memberIds: [], questions: [] }}
          people={people}
          canDelete={false}
        />
      </Card>
    </div>
  );
}
