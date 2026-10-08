import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ClipboardList, CalendarDays, FileQuestion, MessageSquareText, Sparkles } from "lucide-react";
import type { FormCategory } from "@prisma/client";
import { isModuleEnabled } from "@/actions/module";
import { formEditorOptions } from "@/actions/forms";
import { viewerHas } from "@/actions/permission";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { Card } from "@/components/ui/card";
import { FormBuilder } from "@/components/forms/form-builder";
import { CATEGORY_KEYS, FORM_CATEGORIES, categoryOf } from "@/lib/forms/categories";
import { slugFromName } from "@/lib/forms/settings";

const ICONS: Record<FormCategory, typeof CalendarDays> = {
  EVENT: CalendarDays,
  ASSESSMENT: ClipboardList,
  ENQUIRY: MessageSquareText,
  SURVEY: FileQuestion,
  OTHER: Sparkles,
};

export default async function NewFormPage({ searchParams }: { searchParams: Promise<{ category?: string }> }) {
  if (!(await isModuleEnabled("forms"))) return <ModuleDisabledNotice moduleKey="forms" />;
  if (!(await viewerHas("forms.create"))) notFound();

  const { category } = await searchParams;
  const chosen = category && (CATEGORY_KEYS as string[]).includes(category) ? (category as FormCategory) : null;

  if (!chosen) {
    return (
      <div className="animate-fade-rise">
        <Link href="/marketing/forms" className="inline-flex items-center gap-1 text-xs text-muted hover:text-text">
          <ArrowLeft className="h-3.5 w-3.5" /> Forms & events
        </Link>
        <h1 className="mt-2 text-xl font-semibold text-text">What are you making?</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Each kind starts with the questions it usually needs. Change anything afterwards — the starter is a head start,
          not a rule.
        </p>
        <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {FORM_CATEGORIES.map((c) => {
            const Icon = ICONS[c.key];
            return (
              <Link key={c.key} href={{ pathname: "/marketing/forms/new", query: { category: c.key } }}>
                <Card className="h-full px-4 py-4 hover:border-brand">
                  <Icon className="h-5 w-5 text-brand" aria-hidden />
                  <div className="mt-2 text-sm font-semibold text-text">{c.label}</div>
                  <p className="mt-1 text-xs text-muted">{c.blurb}</p>
                  <p className="mt-2 text-[11px] text-subtle">
                    {c.starter.filter((f) => f.type !== "HEADING").length} starter questions
                  </p>
                </Card>
              </Link>
            );
          })}
        </div>
      </div>
    );
  }

  const def = categoryOf(chosen);
  const options = await formEditorOptions();
  return (
    <div className="animate-fade-rise">
      <Link href="/marketing/forms/new" className="inline-flex items-center gap-1 text-xs text-muted hover:text-text">
        <ArrowLeft className="h-3.5 w-3.5" /> Pick a different kind
      </Link>
      <h1 className="mt-2 text-xl font-semibold text-text">New {def.label.toLowerCase()}</h1>
      <div className="mt-4">
        <FormBuilder
          users={options?.users ?? []}
          initialFields={def.starter}
          initial={{
            name: def.defaults.headline,
            slug: slugFromName(def.defaults.headline),
            headline: def.defaults.headline,
            intro: def.defaults.intro,
            thankYouText: def.defaults.thankYouText,
            category: chosen,
            fillMode: def.defaults.fillMode,
            createsLead: def.defaults.createsLead,
            topic: def.defaults.topic,
            assignToUserId: null,
            closesAt: "",
            eventStartsAt: "",
            eventEndsAt: "",
            venue: "",
            capacity: "",
            active: true,
          }}
        />
      </div>
    </div>
  );
}
