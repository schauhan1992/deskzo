import Link from "next/link";
import { redirect } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { listSurveys, surveyOptions } from "@/actions/survey";
import { SurveyManager } from "@/components/engagement/survey-manager";

export default async function ManageSurveysPage() {
  if (!(await isModuleEnabled("engagement"))) return <ModuleDisabledNotice moduleKey="engagement" />;

  const [rows, options] = await Promise.all([listSurveys(), surveyOptions()]);
  if (rows === null) redirect("/surveys");

  return (
    <div className="animate-fade-rise">
      <Link href="/surveys" className="text-sm text-muted hover:text-text">
        ← Forms
      </Link>
      <h1 className="mt-2 text-xl font-semibold text-text">Manage forms</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        Forms, polls and votes. Results on an anonymous form stay hidden until five people have answered,
        whatever permissions you hold.
      </p>
      <div className="mt-5">
        <SurveyManager rows={rows} options={options} />
      </div>
    </div>
  );
}
