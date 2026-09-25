import { Card, CardContent } from "@/components/ui/card";

/**
 * In place of a sync panel, in a workspace that may not change shared data (src/lib/platform/
 * shared-data.ts): the data is there and kept current, just not from here.
 */
export function SharedDataNote({ what }: { what: string }) {
  return (
    <Card>
      <CardContent className="text-sm text-muted">
        {what} is shared by every workspace on this server and kept up to date by the platform — there is nothing to set up or sync here.
      </CardContent>
    </Card>
  );
}
