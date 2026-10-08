"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { applyIndustryTemplate, previewIndustryTemplate, type TemplatesPage } from "@/actions/industry-templates";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { ActionNotice } from "@/components/ui/action-notice";
import { useClock } from "@/components/time/clock-provider";
import type { TemplatePlan } from "@/lib/industry-templates/plan";

const ENTITY = { COMPANY: "customers", VENDOR: "vendors", CONTACT: "contacts", LEAD: "leads", ORDER: "orders", ITEM: "products" } as const;
const MODULE_NAMES: Record<string, string> = { orders: "Orders", renewals: "Renewals" };
const STEP_STATUS = { APPROVED: "Approved", PROCESSING: "Processing", FULFILLED: "Fulfilled" } as const;

/**
 * Settings → Industry templates: each template's pipeline and words at a glance, then exactly what
 * applying it would do here — renamed, added, retired, already there — before anything changes.
 */
export function IndustryTemplatesManager({ page }: { page: TemplatesPage }) {
  const router = useRouter();
  const clock = useClock();
  const [plan, setPlan] = useState<TemplatePlan | null>(null);
  const [done, setDone] = useState<{ name: string; changes: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function preview(key: string) {
    setError(null);
    setDone(null);
    startTransition(async () => {
      const r = await previewIndustryTemplate(key);
      if (!r.ok) setError(r.error);
      else setPlan(r.data);
    });
  }

  function apply() {
    if (!plan) return;
    setError(null);
    startTransition(async () => {
      const r = await applyIndustryTemplate(plan.template.key);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setDone({ name: plan.template.name, changes: r.data.changes });
      setPlan(null);
      router.refresh();
    });
  }

  return (
    <div className="space-y-5">
      {page.missing.length > 0 && (
        <ActionNotice tone="info">
          You can look, but applying a template also changes the pipeline and custom fields — it needs {page.missing.join(" and ")}. Ask whoever runs your
          workspace&apos;s roles.
        </ActionNotice>
      )}
      {error && <ActionNotice tone="error">{error}</ActionNotice>}
      {done && (
        <ActionNotice tone="success">
          {done.changes.length ? `${done.name} applied — ${done.changes.join("; ")}.` : `${done.name} was already in place: nothing needed changing.`}
        </ActionNotice>
      )}

      {plan ? (
        <PlanView plan={plan} pending={pending} canApply={page.missing.length === 0} onApply={apply} onBack={() => setPlan(null)} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {page.templates.map((t) => (
            <Card key={t.key}>
              <CardHeader className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-text">{t.name}</p>
                  <p className="mt-0.5 text-xs text-muted">{t.summary}</p>
                </div>
                <Button size="sm" variant="secondary" onClick={() => preview(t.key)} disabled={pending}>
                  Preview
                </Button>
              </CardHeader>
              <CardContent className="space-y-2 text-xs text-muted">
                <p>
                  <span className="font-medium text-text">Pipeline:</span> {t.stages.join(" → ")}
                </p>
                <p>
                  <span className="font-medium text-text">Order steps:</span> {t.steps.join(" → ")}
                </p>
                <p>
                  <span className="font-medium text-text">Words:</span> {t.words.length ? t.words.join(", ") : "as they are"} ·{" "}
                  <span className="font-medium text-text">{t.fields}</span> custom fields
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {page.applied.length > 0 && !plan && (
        <div>
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-subtle">Applied here</p>
          <ul className="space-y-1 text-xs text-muted">
            {page.applied.map((a) => (
              <li key={a.at}>
                <span className="font-medium text-text">{a.name}</span> · {clock.dateTime(a.at)}
                {a.by ? ` · ${a.by}` : ""} — {a.changes}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Row({ tone, tag, children }: { tone: "green" | "blue" | "amber" | "red" | "default"; tag: string; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-sm">
      <Badge tone={tone} className="mt-0.5 shrink-0">
        {tag}
      </Badge>
      <span className="text-text">{children}</span>
    </li>
  );
}

function PlanView({ plan, pending, canApply, onApply, onBack }: { plan: TemplatePlan; pending: boolean; canApply: boolean; onApply: () => void; onBack: () => void }) {
  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-semibold text-text">Applying {plan.template.name} here would…</span>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={onBack}>
            Back
          </Button>
          <Button size="sm" onClick={onApply} disabled={pending || plan.nothingToDo || !canApply}>
            {pending ? "Applying…" : plan.nothingToDo ? "Nothing to change" : "Apply"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <section>
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-subtle">Pipeline</p>
          <ul className="space-y-1">
            {plan.stages.map((s, i) =>
              s.kind === "rename" ? (
                <Row key={i} tone="blue" tag="Renamed">
                  {s.from} → {s.label} <span className="text-subtle">— its leads stay where they are</span>
                </Row>
              ) : s.kind === "add" ? (
                <Row key={i} tone="green" tag="Added">
                  {s.label}
                </Row>
              ) : s.kind === "keep" ? (
                <Row key={i} tone="default" tag="Already">
                  {s.label}
                </Row>
              ) : s.kind === "stay" ? (
                <Row key={i} tone="amber" tag="Stays">
                  {s.label} <span className="text-subtle">— {s.leads} lead{s.leads === 1 ? " is" : "s are"} in it; retire it from Settings → Pipeline when they&apos;ve moved</span>
                </Row>
              ) : s.kind === "retire" ? (
                <Row key={i} tone="red" tag="Retired">
                  {s.label} <span className="text-subtle">— empty; Settings → Pipeline can restore it</span>
                </Row>
              ) : (
                <Row key={i} tone="amber" tag="Skipped">
                  {s.label} <span className="text-subtle">— {s.why}</span>
                </Row>
              ),
            )}
          </ul>
        </section>

        <section>
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-subtle">Order steps</p>
          <ul className="space-y-1">
            {plan.steps.map((s, i) => (
              <Row key={i} tone={s.kind === "skip" ? "amber" : s.kind === "exists" ? "default" : "green"} tag={s.kind === "skip" ? "Skipped" : s.kind === "exists" ? "Already" : s.kind === "restore" ? "Restored" : "Added"}>
                {s.label} <span className="text-subtle">— under {STEP_STATUS[s.status]}{s.kind === "skip" ? `; ${s.why}` : ""}</span>
              </Row>
            ))}
          </ul>
        </section>

        {plan.words.length > 0 && (
          <section>
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-subtle">Wording</p>
            <ul className="space-y-1">
              {plan.words.map((w) => (
                <Row key={w.key} tone={w.kind === "set" ? "blue" : "default"} tag={w.kind === "set" ? "Renamed" : "Already"}>
                  {w.kind === "set" ? `${w.from} → ${w.to}` : w.to}
                </Row>
              ))}
            </ul>
          </section>
        )}

        <section>
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-subtle">Custom fields</p>
          <ul className="space-y-1">
            {plan.fields.map((f, i) => (
              <Row key={i} tone={f.kind === "skip" ? "amber" : f.kind === "exists" ? "default" : "green"} tag={f.kind === "skip" ? "Skipped" : f.kind === "exists" ? "Already" : f.kind === "restore" ? "Restored" : "Added"}>
                {f.field.label} <span className="text-subtle">— on {ENTITY[f.field.entity]}{f.field.options ? ` (${f.field.options.join(", ")})` : ""}{f.kind === "skip" ? `; ${f.why}` : ""}</span>
              </Row>
            ))}
          </ul>
        </section>

        {plan.modules.length > 0 && (
          <section>
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-subtle">Modules</p>
            <ul className="space-y-1">
              {plan.modules.map((m) => (
                <Row key={m.key} tone={m.kind === "switch-on" ? "green" : m.kind === "on" ? "default" : "amber"} tag={m.kind === "switch-on" ? "Switched on" : m.kind === "on" ? "Already on" : "Not in plan"}>
                  {MODULE_NAMES[m.key] ?? m.key}
                </Row>
              ))}
            </ul>
          </section>
        )}

        <p className="text-xs text-subtle">Nothing is deleted. Every change can be adjusted afterwards under Settings → Pipeline, Wording and Custom fields.</p>
      </CardContent>
    </Card>
  );
}
