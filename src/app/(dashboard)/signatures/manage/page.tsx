import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { hasEffectivePermission } from "@/actions/permission";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import { zohoApp } from "@/lib/workplace/settings";
import { PERSON_SELECT, brandLogoUsable, loadPerson, personSignature, readTemplate, signatureContext, templateIdFor, type Person } from "@/lib/signatures/person";
import { BANNER_SELECT, bannerFor, bannerImageSrc, bannerState, bannerTemplateIds } from "@/lib/signatures/banners";
import { getBranding } from "@/actions/branding";
import { workspaceClock } from "@/lib/time/workspace";
import { readSignatureSettings } from "@/lib/signatures/sync";
import { OUTLOOK_PATHS } from "@/lib/signatures/outlook";
import { TabNav } from "@/components/ui/tab-nav";
import { SignaturePeopleTable, type SignaturePersonRow } from "@/components/signatures/people-table";
import { SignatureTemplates, type SignatureTemplateDraft } from "@/components/signatures/template-editor";
import { SignatureRulesEditor, type SignatureRuleRow } from "@/components/signatures/rules-editor";
import { SignatureConnectionPanel } from "@/components/signatures/connection-panel";
import { SignatureBanners, type BannerView } from "@/components/signatures/banner-editor";
import { SignatureMailboxes, type MailboxView } from "@/components/signatures/mailboxes-editor";
import { ClicksReport } from "@/components/signatures/clicks-report";
import { CLICK_PERIODS, bannerClicks, clickDetail, clickItems } from "@/lib/signatures/clicks";

/**
 * Email signatures, for whoever holds `signatures.manage`: everybody's signature and whether it is in
 * their mailbox, the templates, who gets which, and the connected mail suite. A refusal is a 404.
 */
export default async function ManageSignaturesPage({ searchParams }: { searchParams: Promise<{ tab?: string; mailbox?: string; days?: string; item?: string }> }) {
  if (!(await isModuleEnabled("signatures"))) return <ModuleDisabledNotice moduleKey="signatures" />;
  const me = await requireUser();
  if (!(await hasEffectivePermission(me.id, "signatures.manage"))) notFound();
  const { tab: rawTab, mailbox, days: rawDays, item: rawItem } = await searchParams;
  const tab = rawTab === "templates" || rawTab === "banners" || rawTab === "clicks" || rawTab === "rules" || rawTab === "connection" ? rawTab : "people";

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
    const drafts: SignatureTemplateDraft[] = rows.map((t) => ({ ...t, shown: t.shown, social: t.social, people: counts.get(t.id) ?? 0, banner: bannerFor(t.id, ctx.banners) }));
    const branding = await getBranding();
    body = (
      <SignatureTemplates
        templates={drafts}
        company={ctx.company}
        brand={{ logo: ctx.brandLogo, logoUnusable: !!branding.logoDataUrl && !brandLogoUsable(branding.logoDataUrl) }}
        everybodyBanner={bannerFor("", ctx.banners)}
      />
    );
  } else if (tab === "banners") {
    const [rows, mine, today, clicks] = await Promise.all([
      db.signatureBanner.findMany({ where: { removedAt: null }, orderBy: [{ createdAt: "desc" }], select: BANNER_SELECT }),
      loadPerson(me.id),
      workspaceClock().then((c) => c.today()),
      bannerClicks(30),
    ]);
    const banners: BannerView[] = rows.map((b) => ({
      id: b.id,
      name: b.name,
      // In the app, the upload's address on this host.
      imageSrc: bannerImageSrc(b, ""),
      imageUrl: b.imageUrl,
      linkUrl: b.linkUrl ?? "",
      altText: b.altText,
      width: b.width,
      startsOn: b.startsOn?.toISOString().slice(0, 10) ?? null,
      endsOn: b.endsOn?.toISOString().slice(0, 10) ?? null,
      paused: b.paused,
      templateIds: bannerTemplateIds(b),
      state: bannerState(b, today),
      clicks: clicks.get(b.id) ?? 0,
    }));
    // The manager's own signature, without a banner, to show one under.
    const sampleHtml = mine ? (await personSignature(mine, { ...ctx, banners: [] })).html : "";
    body = (
      <SignatureBanners
        banners={banners}
        templates={[...ctx.templates.values()].map((t) => ({ id: t.id, name: t.name }))}
        sampleHtml={sampleHtml}
        counting={settings?.trackClicks ?? true}
      />
    );
  } else if (tab === "clicks") {
    const days = (CLICK_PERIODS as readonly number[]).includes(Number(rawDays)) ? Number(rawDays) : 30;
    const items = await clickItems(days);
    const picked = items.find((i) => i.key === rawItem) ?? null;
    body = (
      <ClicksReport
        counting={settings?.trackClicks ?? true}
        days={days}
        items={items}
        selected={picked ? { item: picked, detail: await clickDetail(picked.kind, picked.refId, days) } : null}
      />
    );
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
    const templateList = [...ctx.templates.values()].map((t) => ({ id: t.id, name: t.name }));
    const mailboxes: MailboxView[] = (await db.signatureMailbox.findMany({ orderBy: { address: "asc" } })).map((m) => ({
      id: m.id,
      address: m.address,
      name: m.name,
      phone: m.phone ?? "",
      templateId: m.templateId,
      templateName: (m.templateId && ctx.templates.get(m.templateId)?.name) || "The default",
    }));
    body = (
      <div className="space-y-5">
        <SignatureRulesEditor rules={rules} templates={templateList} choices={choices} />
        <SignatureMailboxes mailboxes={mailboxes} templates={templateList} outlookOn={settings?.outlookOn ?? false} />
      </div>
    );
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
          { key: "banners", label: "Banners", count: ctx.banners.length || undefined },
          { key: "clicks", label: "Clicks" },
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
