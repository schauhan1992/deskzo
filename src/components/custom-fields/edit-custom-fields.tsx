"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { CustomFieldInputs, missingRequired, type CustomFieldFormValues, type CustomFieldPerson } from "@/components/custom-fields/custom-field-inputs";
import type { CustomFieldDef } from "@/lib/custom-fields/rules";

/**
 * The Edit button on a record's "More details" card, and the dialog behind it. `save` is the record
 * type's own action with the record bound to it (e.g. `updateItemCustomFields.bind(null, id)`), so
 * the rules about who may change the record are that record type's, not this component's.
 */
export function EditCustomFields({
  title,
  fields,
  initial,
  people = [],
  save,
}: {
  title: string;
  fields: CustomFieldDef[];
  initial: CustomFieldFormValues;
  people?: CustomFieldPerson[];
  save: (input: CustomFieldFormValues) => Promise<{ ok: true } | { ok: false; error: string }>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<CustomFieldFormValues>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function submit() {
    const missing = missingRequired(fields, values);
    setErrors(missing);
    if (Object.keys(missing).length > 0) return;
    setError(null);
    startTransition(async () => {
      const result = await save(values);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => {
          setValues(initial);
          setErrors({});
          setError(null);
          setOpen(true);
        }}
      >
        Edit
      </Button>
      {open && (
        <Dialog open onClose={() => setOpen(false)} title={title} wide>
          <div className="space-y-4">
            {error && (
              <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">
                {error}
              </p>
            )}
            <CustomFieldInputs
              fields={fields}
              values={values}
              people={people}
              errors={errors}
              idPrefix="cf-edit"
              disabled={isPending}
              onChange={(key, value) => {
                setValues((v) => ({ ...v, [key]: value }));
                setErrors((e) => {
                  if (!e[key]) return e;
                  const next = { ...e };
                  delete next[key];
                  return next;
                });
              }}
            />
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button type="button" size="sm" onClick={submit} disabled={isPending}>
              {isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </Dialog>
      )}
    </>
  );
}
