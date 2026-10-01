import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { FollowUpHistory } from "@/components/collections/follow-up-history";
import { LogFollowUpButton, type LogFollowUpTarget } from "@/components/collections/log-follow-up-button";
import type { FollowUpView } from "@/lib/collections/load";

/**
 * "Payment follow-ups" on an invoice or an order: the whole history — shared by sales and accounts —
 * and the Log follow-up button for whoever may log one. The page fetches the data (`followUpPanel` in
 * src/actions/collections.ts) after asking whether Receivables is there, and hands it in.
 */
export function FollowUpPanel({
  panel,
}: {
  panel: { history: FollowUpView[]; canLog: boolean; target: LogFollowUpTarget };
}) {
  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium text-text">
        <span>
          Payment follow-ups
          {panel.history.length > 0 && <span className="ml-2 text-xs font-normal text-subtle">{panel.history.length}</span>}
        </span>
        {panel.canLog && <LogFollowUpButton target={panel.target} />}
      </CardHeader>
      <CardContent>
        <FollowUpHistory
          history={panel.history}
          showTarget={panel.history.some((h) => h.targetLabel !== panel.target.label)}
          emptyText={panel.canLog ? "Nobody has followed this up yet. Log what the client says, and any date they promise to pay by." : "Nobody has followed this up yet."}
        />
      </CardContent>
    </Card>
  );
}
