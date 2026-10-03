import { Eye, History } from "lucide-react";
import type { permissionChangeHistory } from "@/actions/access";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { workspaceClock } from "@/lib/time/workspace";

type Row = Awaited<ReturnType<typeof permissionChangeHistory>>[number];

/**
 * Who changed what, and when.
 *
 * `recordPermissionChange` has fired on every grant, revoke, reset and preset since the permission
 * system was written, and nothing has ever read the table. So "who gave them that, and on what
 * date?" — the first question of any access review — had no answer inside the product, while the
 * answer sat in the database the whole time.
 */

const KIND_LABEL: Record<string, string> = {
  GRANT: "Granted",
  REVOKE: "Revoked",
  RESET_TO_DEFAULT: "Reset to default",
  PRESET_APPLIED: "Preset applied",
  ROLE_ASSIGNED: "Role changed",
  MANAGER_CHANGED: "Reporting line changed",
  DEPARTMENT_CHANGED: "Department changed",
  USER_CREATED: "User created",
  USER_ACTIVATED: "Account reactivated",
  USER_DEACTIVATED: "Account deactivated",
  TWO_FACTOR_RESET: "Two-factor reset",
  SUPER_ADMIN_GRANTED: "Made super admin",
  SUPER_ADMIN_REVOKED: "Super admin removed",
};

const KIND_TONE: Record<string, "green" | "red" | "amber" | "default"> = {
  GRANT: "green",
  USER_ACTIVATED: "green",
  REVOKE: "red",
  USER_DEACTIVATED: "red",
  SUPER_ADMIN_REVOKED: "red",
  SUPER_ADMIN_GRANTED: "amber",
  PRESET_APPLIED: "amber",
  MANAGER_CHANGED: "amber",
};

export async function ChangeHistory({ rows, title }: { rows: Row[]; title: string }) {
  const clock = await workspaceClock();
  return (
    <Card>
      <CardHeader className="flex items-center gap-2 text-sm font-medium text-text">
        <History className="h-4 w-4 text-muted" />
        {title}
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted">Nothing has changed yet.</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {rows.map((row) => (
              <li key={row.id} className="flex flex-wrap items-start justify-between gap-2 py-2 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={KIND_TONE[row.changeKind] ?? "default"}>
                      {KIND_LABEL[row.changeKind] ?? row.changeKind}
                    </Badge>
                    <span className="text-text">
                      {row.subjectUser?.name ?? row.subjectRole ?? "—"}
                    </span>
                    {row.impersonatedByUserId && (
                      <Badge tone="amber">
                        {/*
                          Attributed to the real person, not the borrowed account — which is the
                          whole reason the column exists.
                        */}
                        <Eye className="h-3 w-3" />
                        while viewing as
                      </Badge>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-muted">{row.detail ?? row.permission ?? ""}</p>
                </div>
                <span className="shrink-0 text-xs text-subtle">
                  {clock.dateTimeShort(row.createdAt)}
                  {row.actor?.name && <span className="block text-right">by {row.actor.name}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
