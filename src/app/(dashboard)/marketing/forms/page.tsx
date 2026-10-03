import Link from "next/link";
import { CalendarDays, Plus, Users } from "lucide-react";
import { isModuleEnabled } from "@/actions/module";
import { listForms } from "@/actions/forms";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SearchParamInput } from "@/components/ui/search-param-input";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { FORM_CATEGORIES, FILL_MODES, categoryOf } from "@/lib/forms/categories";
import { seatsText } from "@/lib/forms/invites";
import { workspaceClock } from "@/lib/time/workspace";
import { cn } from "@/lib/utils";

export default async function FormsPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string; q?: string; state?: string }>;
}) {
  if (!(await isModuleEnabled("forms"))) return <ModuleDisabledNotice moduleKey="forms" />;
  const params = await searchParams;
  const [data, clock] = await Promise.all([listForms(params), workspaceClock()]);
  if (!data) return <ModuleDisabledNotice moduleKey="forms" />;

  const total = Object.values(data.byCategory).reduce((a, b) => a + b, 0);
  const chip = (key: string | null, label: string, count: number) => {
    const active = (params.category ?? null) === key;
    const query = { ...(params.q ? { q: params.q } : {}), ...(params.state ? { state: params.state } : {}), ...(key ? { category: key } : {}) };
    return (
      <Link
        key={key ?? "all"}
        href={{ pathname: "/marketing/forms", query }}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium",
          active ? "border-brand bg-brand-subtle text-brand" : "border-line text-muted hover:bg-surface-sunken hover:text-text",
        )}
      >
        {label}
        <span className="tabular-nums opacity-70">{count}</span>
      </Link>
    );
  };

  return (
    <div className="animate-fade-rise">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text">Forms & events</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            Roundtables and event invitations, requirement assessments, enquiry and survey forms. Each one is shared
            deliberately: you see the forms you built and the ones somebody gave you, and each form decides who can
            change it, invite to it and read what people answered.
          </p>
        </div>
        {data.canCreate && (
          <Link href="/marketing/forms/new">
            <Button size="sm">
              <Plus className="h-3.5 w-3.5" />
              New form
            </Button>
          </Link>
        )}
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        {chip(null, "All", total)}
        {FORM_CATEGORIES.filter((c) => data.byCategory[c.key]).map((c) => chip(c.key, c.label, data.byCategory[c.key] ?? 0))}
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <SearchParamInput paramName="q" placeholder="Search by name or address…" className="w-full sm:w-72" />
        <SelectParamFilter
          paramName="state"
          label="Status"
          options={[
            { value: "open", label: "Open" },
            { value: "closed", label: "Closed" },
          ]}
        />
      </div>

      <div className="mt-4 space-y-2.5">
        {data.rows.length === 0 ? (
          <Card className="px-4 py-12 text-center text-sm text-subtle">
            {total === 0
              ? data.canCreate
                ? "No forms yet. Start with an event invitation or a requirement assessment — the questions come pre-filled."
                : "Nobody has shared a form with you yet."
              : "No form matches that."}
          </Card>
        ) : (
          data.rows.map((form) => (
            <Card key={form.id} className="px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/marketing/forms/${form.id}`} className="text-sm font-medium text-text hover:underline">
                      {form.name}
                    </Link>
                    <Badge tone={form.category === "EVENT" ? "brand" : form.category === "ASSESSMENT" ? "blue" : "default"}>
                      {categoryOf(form.category).label}
                    </Badge>
                    {!form.active ? <Badge tone="default">Closed</Badge> : !form.open ? <Badge tone="amber">Not taking answers</Badge> : <Badge tone="green">Open</Badge>}
                    <span className="text-[11px] text-subtle">{FILL_MODES.find((m) => m.key === form.fillMode)?.label}</span>
                  </div>
                  <p className="text-xs text-muted">
                    {form.category === "EVENT" && form.eventStartsAt && (
                      <span className="mr-3 inline-flex items-center gap-1">
                        <CalendarDays className="h-3 w-3" aria-hidden />
                        {clock.dateTime(form.eventStartsAt)}
                        {form.venue ? ` · ${form.venue}` : ""}
                      </span>
                    )}
                    <span className="text-subtle">
                      /forms/{form.slug} · {form.owner.name}
                      {form.access.via === "grant" && ` · shared with you${[form.access.edit && "can edit", form.access.invite && "can invite", form.access.responses && "can read answers"].filter(Boolean).map((s) => `, ${s}`).join("")}`}
                    </span>
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-4 text-right text-xs text-muted">
                  {form.coming !== null && (
                    <div>
                      <div className="text-sm font-semibold tabular-nums text-text">{seatsText(form.coming, form.capacity)}</div>
                      <div>coming</div>
                    </div>
                  )}
                  {form.invited > 0 && (
                    <div>
                      <div className="text-sm font-semibold tabular-nums text-text">{form.invited}</div>
                      <div>invited</div>
                    </div>
                  )}
                  {form.responses !== null && (
                    <div>
                      <div className="text-sm font-semibold tabular-nums text-text">{form.responses}</div>
                      <div>{form.responses === 1 ? "answer" : "answers"}</div>
                    </div>
                  )}
                  {form.shared > 0 && form.access.share && (
                    <span className="inline-flex items-center gap-1" title="Shared with other people or roles">
                      <Users className="h-3.5 w-3.5" aria-hidden />
                      {form.shared}
                    </span>
                  )}
                </div>
              </div>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
