import Link from "next/link";
import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { getSurveyToFill } from "@/actions/survey";
import { SurveyFill } from "@/components/engagement/survey-fill";
import { Card, CardContent } from "@/components/ui/card";

export default async function SurveyPage({ params }: { params: Promise<{ id: string }> }) {
  if (!(await isModuleEnabled("engagement"))) return <ModuleDisabledNotice moduleKey="engagement" />;

  const { id } = await params;
  const survey = await getSurveyToFill(id);
  // Not targeted at them and not existing are the same answer, so a link forwarded by a colleague
  // reveals nothing about what other teams are being asked.
  if (!survey) notFound();

  return (
    <div className="animate-fade-rise mx-auto max-w-2xl">
      <Link href="/surveys" className="text-sm text-muted hover:text-text">
        ← Forms
      </Link>
      <div className="mt-3">
        {survey.answered ? (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted">
              You&apos;ve already answered this one.
            </CardContent>
          </Card>
        ) : !survey.open ? (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted">This form has closed.</CardContent>
          </Card>
        ) : (
          <SurveyFill survey={survey} />
        )}
      </div>
    </div>
  );
}
