import Link from "next/link";
import { ClipboardList, Lock } from "lucide-react";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { myOpenSurveys } from "@/actions/survey";
import { hasEffectivePermission } from "@/actions/permission";
import { requireUser } from "@/lib/session";
import { Badge, Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { surveyKindLabels } from "@/lib/engagement/anonymity";
import { workspaceClock } from "@/lib/time/workspace";

/**
 * What is waiting for this person.
 *
 * Only forms they are actually in the audience for, and only open ones — a list that showed a
 * locked form for another department would tell them it exists, which is itself information.
 */
export default async function SurveysPage() {
  if (!(await isModuleEnabled("engagement"))) return <ModuleDisabledNotice moduleKey="engagement" />;

  const user = await requireUser();
  const [surveys, canManage, clock] = await Promise.all([
    myOpenSurveys(),
    hasEffectivePermission(user.id, "engagement.manage"),
    workspaceClock(),
  ]);

  const todo = surveys.filter((s) => !s.answered);
  const done = surveys.filter((s) => s.answered);

  return (
    <div className="animate-fade-rise">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text">Forms &amp; polls</h1>
          <p className="mt-1 text-sm text-muted">What&apos;s open for you right now.</p>
        </div>
        {canManage && (
          <Link href="/surveys/manage">
            <Button variant="secondary">Manage forms</Button>
          </Link>
        )}
      </div>

      {surveys.length === 0 ? (
        <Card className="mt-5">
          <CardContent className="py-10 text-center text-sm text-muted">Nothing is waiting for you.</CardContent>
        </Card>
      ) : (
        <div className="mt-5 space-y-3">
          {[...todo, ...done].map((s) => (
            <Link key={s.id} href={`/surveys/${s.id}`} className="block">
              <Card className={`transition hover:border-line-strong ${s.answered ? "opacity-60" : ""}`}>
                <CardContent className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-2.5">
                    <ClipboardList className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-text">{s.title}</span>
                        <Badge tone="default">{surveyKindLabels[s.kind]}</Badge>
                        {s.anonymous && (
                          <span className="flex items-center gap-1 text-xs text-success">
                            <Lock className="h-3 w-3" />
                            Anonymous
                          </span>
                        )}
                        {s.mandatory && !s.answered && <Badge tone="amber">Must fill</Badge>}
                        {s.answered && <Badge tone="green">Done</Badge>}
                      </div>
                      {s.description && <p className="mt-0.5 truncate text-xs text-muted">{s.description}</p>}
                    </div>
                  </div>
                  <div className="shrink-0 text-right text-xs text-subtle">
                    {s.questions} question{s.questions === 1 ? "" : "s"}
                    {/* The last second of its last day on the workspace's clock (src/actions/survey.ts). */}
                    {s.expiresAt && <div>Closes {clock.date(s.expiresAt)}</div>}
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
