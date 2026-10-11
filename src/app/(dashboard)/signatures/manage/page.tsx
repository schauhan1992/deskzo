import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { hasEffectivePermission } from "@/actions/permission";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import { zohoApp } from "@/lib/workplace/settings";
import { PERSON_SELECT, personSignature, readTemplate, signatureContext, templateIdFor, type Person } from "@/lib/signatures/person";
import { readSignatureSettings } from "@/lib/signatures/sync";
import { OUTLOOK_PATHS } from "@/lib/signatures/outlook";
import { TabNav } from "@/components/ui/tab-nav";
import { SignaturePeopleTable, type SignaturePersonRow } from "@/components/signatures/people-table";
import { SignatureTemplates, type SignatureTemplateDraft } from "@/components/signatures/template-editor";
import { SignatureRulesEditor, type SignatureRuleRow } from "@/components/signatures/rules-editor";
import { SignatureConnectionPanel } from "@/components/signatures/connection-panel";

/**
 * Email signatures, for whoever holds `signatures.manage`: everybody's signature and whether it is in
 * their mailbox, the templates, who gets which, and the connected mail suite. A refusal is a 404.
 */
export default async function ManageSignaturesPage({ searchParams }: { searchParams: Promise<{ tab?: string; mailbox?: string }> }) {
  if (!(await isModuleEnabled("signatures"))) return <ModuleDisabledNotice moduleKey="signatures" />;
  const me = await requireUser();
  if (!(await hasEffectivePermission(me.id, "signatures.manage"))) notFound();
  const { tab: rawTab, mailbox } = await searchParams;
  const tab = rawTab === "templates" || rawTab === "rules" || rawTab === "connection" ? rawTab : "people";

  const [ctx, settings] = await Promise.all([signatureContext(me.id), readSignatureSettings()]);
  const people = (await db.user.findMany({ where: { active: true, kind: "MEMBER" }, orderBy: { name: "asc" }, select: PERSON_SELECT })) as Person[];
  const counts = new Map<string, number>();
  for (const p of people) {
    const id = templateIdFor(p, ctx.rules, ctx.defaultId);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const templateName = (id: string) => ctx.templates.get(id)?.name ?? "Default";

  let body: React.ReactNode;
  if (tab === "templates") {
    const rows = (await db.signatureTemplate.findMany({ orderBy: [{ isDefault: "desc" }, { name: "asc" }] })).map(readTemplate);
    const drafts: SignatureTemplateDraft[] = rows.map((t) => ({ ...t, shown: t.shown, social: t.social, people: counts.get(t.id) ?? 0 }));
    body = <SignatureTemplates templates={drafts} company={ctx.company} />;
  } else if (tab === "rules") {
    const [departments, branches, roles] = await Promise.all([
      db.department.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
      db.branch.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
      db.role.findMany({ orderBy: { name: "asc" }, select: { key: true, name: true } }),
    ]);
    const choices = {
      PERSON: people.map((p) => ({ id: p.id, name: p.name })),
      DEPARTMENT: departments,
      BRANCH: branches,
      ROLE: roles.map((r) => ({ id: r.key, name: r.name })),
    };
    const nameOf = (target: keyof typeof choices, id: string) => choices[target].find((c) => c.id === id)?.name ?? "(no longer there)";
    const rules: SignatureRuleRow[] = ctx.rules.map((r) => ({
      target: r.target as SignatureRuleRow["target"],
      targetId: r.targetId,
      targetName: nameOf(r.target as keyof typeof choices, r.targetId),
      templateId: r.templateId,
      templateName: templateName(r.templateId),
    }));
    body = <SignatureRulesEditor rules={rules} templates={[...ctx.templates.values()].map((t) => ({ id: t.id, name: t.name }))} choices={choices} />;
  } else if (tab === "connection") {
    const outlookSeen = await db.signatureOutlook.aggregate({ _count: { _all: true }, _max: { fetchedAt: true } });
    body = (
      <SignatureConnectionPanel
        outcome={mailbox ?? null}
        view={{
          provider: settings?.provider === "GOOGLE" || settings?.provider === "ZOHO" ? settings.provider : null,
          googleServiceEmail: settings?.googleServiceEmail ?? null,
          zohoAdminEmail: settings?.zohoAdminEmail ?? null,
          zohoOrgId: settings?.zohoOrgId ?? null,
          autoSync: settings?.autoSync ?? true,
          connectedAt: settings?.connectedAt?.toISOString() ?? null,
          lastRunAt: settings?.lastRunAt?.toISOString() ?? null,
          lastError: settings?.lastError ?? null,
          zohoAppReady: !!(await zohoApp()),
          outlook: {
            on: settings?.outlookOn ?? false,
            ready: !!settings?.outlookAddinId,
            replaceOwn: settings?.outlookReplaceOwn ?? true,
            manifestPath: OUTLOOK_PATHS.manifest,
            people: outlookSeen._count._all,
            lastAt: outlookSeen._max.fetchedAt?.toISOString() ?? null,
          },
        }}
      />
    );
  } else {
    const ids = people.map((p) => p.id);
    const syncs = new Map((await db.signatureSync.findMany({ where: { userId: { in: ids } } })).map((s) => [s.userId, s]));
    const outlook = settings?.outlookOn ? new Map((await db.signatureOutlook.findMany({ where: { userId: { in: ids } } })).map((o) => [o.userId, o])) : null;
    const rows: SignaturePersonRow[] = [];
    for (const p of people) {
      const s = syncs.get(p.id);
      const sig = await personSignature(p, ctx);
      const state: SignaturePersonRow["state"] = !s
        ? "none"
        : s.status === "SYNCED"
          ? s.syncedHash === sig.hash && s.provider === settings?.provider
            ? "current"
            : "changed"
          : s.status === "FAILED"
            ? "failed"
            : s.status === "SKIPPED"
              ? "skipped"
              : "pending";
      const seen = outlook?.get(p.id);
      rows.push({
        userId: p.id,
        name: p.name,
        email: p.email,
        template: templateName(sig.templateId),
        state,
        syncedAt: s?.syncedAt?.toISOString() ?? null,
        error: s?.lastError ?? null,
        outlook: seen ? { at: seen.fetchedAt.toISOString(), current: seen.hash === sig.hash } : null,
      });
    }
    body = <SignaturePeopleTable rows={rows} connected={!!settings?.provider} outlookOn={!!settings?.outlookOn} />;
  }

  return (
    <div className="animate-fade-rise space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-text">Email signatures</h1>
        <p className="mt-1 text-sm text-muted">
          One design, each person&apos;s details from their record, put into their Gmail, Zoho Mail or Outlook and kept in step.
        </p>
      </div>
      <TabNav
        tabs={[
          { key: "people", label: "People" },
          { key: "templates", label: "Templates", count: ctx.templates.size },
          { key: "rules", label: "Who gets which" },
          { key: "connection", label: "Connection" },
        ]}
        activeKey={tab}
        basePath="/signatures/manage"
      />
      {body}
    </div>
  );
}
