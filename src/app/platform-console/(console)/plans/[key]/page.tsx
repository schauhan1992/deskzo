import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight, CopyPlus, Star } from "lucide-react";
import { Banner } from "@/components/console/kit/banner";
import { PageHeader } from "@/components/console/kit/page-header";
import { StatusPill } from "@/components/console/kit/status";
import { PlanEditor } from "@/components/console/plans/plan-editor";
import { plural } from "@/lib/console-shared/format";
import { planKindLabel } from "@/lib/console-shared/labels";
import { PAGE_ROLES } from "@/lib/console-shared/nav";
import { capsFor } from "@/lib/console-shared/roles";
import { planDetail } from "@/lib/platform/console-data";
import { consoleStaff } from "@/lib/platform/console-page";
import { moduleCatalogue } from "@/lib/platform/plans";

/** From the address only — a title never carries data past the sign-in gate. */
export async function generateMetadata({ params }: PageProps<"/platform-console/plans/[key]">): Promise<Metadata> {
  const { key } = await params;
  return { title: `${String(key).slice(0, 60)} · Plan` };
}

const SECONDARY_LINK =
  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-base border border-line-strong bg-surface px-3 text-[13px] font-medium whitespace-nowrap text-text shadow-sm hover:bg-surface-sunken";

/**
 * One plan (spec §3.10): everyone reads it; sellers change it — an internal plan only the owner —
 * and everybody else sees the same sections as plain definitions, with no controls.
 */
export default async function ConsolePlanPage({ params }: PageProps<"/platform-console/plans/[key]">) {
  const staff = await consoleStaff(PAGE_ROLES.plans);
  const caps = capsFor(staff.role);
  const { key } = await params;
  const plan = await planDetail(String(key));
  if (!plan) notFound();
  const catalogue = moduleCatalogue();

  const internal = plan.kind === "INTERNAL";
  const editable = caps.sell && (!internal || caps.editInternalPlans);

  return (
    <>
      <PageHeader
        crumbs={[{ label: "Plans", href: "/plans" }, { label: plan.name }]}
        title={plan.name}
        chips={
          <>
            <StatusPill tone={internal ? "warning" : "neutral"}>{planKindLabel(plan.kind)}</StatusPill>
            {plan.isDefault && (
              <StatusPill tone="brand" icon={<Star className="h-3 w-3" />}>
                Default for new workspaces
              </StatusPill>
            )}
            {!plan.active && <StatusPill tone="neutral">Retired</StatusPill>}
          </>
        }
        subtitle={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-mono text-xs text-text">{plan.key}</span>
            <span aria-hidden="true">·</span>
            {plan.workspaces > 0 ? (
              <Link href={`/workspaces?plan=${encodeURIComponent(plan.key)}`} className="inline-flex items-center gap-1 rounded-base font-medium text-brand hover:underline">
                On {plural(plan.workspaces, "workspace")}
                <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
              </Link>
            ) : (
              <span>No workspaces on it yet</span>
            )}
          </span>
        }
        actions={
          editable ? (
            <Link href={`/plans/new?from=${encodeURIComponent(plan.key)}`} className={SECONDARY_LINK}>
              <CopyPlus aria-hidden="true" className="h-4 w-4" />
              Duplicate
            </Link>
          ) : undefined
        }
      />
      {internal && caps.sell && !editable && (
        <Banner tone="info" title="Internal plans are changed by an owner." className="mb-6">
          It is never sold: the installation&apos;s own workspace and staff test workspaces are on plans like this.
        </Banner>
      )}
      <PlanEditor initial={plan} catalogue={catalogue} owner={caps.editInternalPlans} mode="edit" readOnly={!editable} />
    </>
  );
}
