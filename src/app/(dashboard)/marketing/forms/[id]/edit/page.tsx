import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { isModuleEnabled } from "@/actions/module";
import { formEditorOptions, getFormForEdit } from "@/actions/forms";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { FormBuilder } from "@/components/forms/form-builder";
import { istDateTimeInput } from "@/lib/india-time";

export default async function EditFormPage({ params }: { params: Promise<{ id: string }> }) {
  if (!(await isModuleEnabled("forms"))) return <ModuleDisabledNotice moduleKey="forms" />;
  const { id } = await params;
  // Not yours to change answers the same as not there: an id says nothing about what is behind it.
  const [form, options] = await Promise.all([getFormForEdit(id), formEditorOptions()]);
  if (!form) notFound();

  return (
    <div className="animate-fade-rise">
      <Link href={`/marketing/forms/${form.id}`} className="inline-flex items-center gap-1 text-xs text-muted hover:text-text">
        <ArrowLeft className="h-3.5 w-3.5" /> {form.name}
      </Link>
      <h1 className="mt-2 text-xl font-semibold text-text">Edit form</h1>
      <div className="mt-4">
        <FormBuilder
          formId={form.id}
          hasResponses={form.hasResponses}
          users={options?.users ?? []}
          initialFields={form.fields}
          initial={{
            name: form.name,
            slug: form.slug,
            headline: form.headline ?? "",
            intro: form.intro ?? "",
            thankYouText: form.thankYouText ?? "",
            category: form.category,
            fillMode: form.fillMode,
            createsLead: form.createsLead,
            topic: form.topic,
            assignToUserId: form.assignToUserId,
            closesAt: istDateTimeInput(form.closesAt),
            eventStartsAt: istDateTimeInput(form.eventStartsAt),
            eventEndsAt: istDateTimeInput(form.eventEndsAt),
            venue: form.venue ?? "",
            capacity: form.capacity === null ? "" : String(form.capacity),
            active: form.active,
          }}
        />
      </div>
    </div>
  );
}
