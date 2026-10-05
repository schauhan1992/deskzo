import type { ReactNode } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRight,
  Check,
  CircleDashed,
  Clock,
  FilePen,
  FileText,
  Gauge,
  ImageOff,
  ImagePlus,
  Inbox,
  Newspaper,
  PanelsTopLeft,
  PenLine,
  Rocket,
  Settings,
  Sparkles,
  UserPlus,
} from "lucide-react";
import { KpiGrid, KpiTile } from "@/components/console/charts/kpi-tile";
import { Meter } from "@/components/console/charts/meter";
import { ActivityFeed } from "@/components/console/kit/activity-feed";
import { EmptyState } from "@/components/console/kit/empty-state";
import { PageHeader } from "@/components/console/kit/page-header";
import { HiddenSiteBanner } from "@/components/cms/common/hidden-site-banner";
import { Panel } from "@/components/console/kit/panel";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { TONE_PILL } from "@/components/console/kit/status";
import { activityFeedItems } from "@/components/cms/common/activity";
import { CmsRolePill } from "@/components/cms/common/status";
import { ScoreFigure } from "@/components/cms/seo/score-ui";
import { NewItemButton } from "@/components/cms/shell/new-menu";
import { plural } from "@/lib/console-shared/format";
import { cmsDashboard } from "@/lib/cms/content";
import { cmsPage } from "@/lib/cms/guard";
import { CMS_PAGE_ROLES, CMS_ROUTES } from "@/lib/cms/nav";
import { siteSummary } from "@/lib/cms/seo-scores";
import { CMS_ROLE_DESCRIPTIONS, cmsCapsFor, type CmsCaps, type CmsMe, type SeoSiteSummary } from "@/lib/cms/types";
import { cn } from "@/lib/utils";
import { consoleClock } from "@/lib/platform/console-clock";
import { getSiteSettings, siteOrigin } from "@/lib/platform/site-content";

export const metadata: Metadata = { title: "Dashboard" };

const num = (n: number) => n.toLocaleString("en-IN");

/** The dashboard's figures and the clock it was read by — the console's day and hour (Settings › Time zone), from the server. */
async function loadDashboard(me: CmsMe) {
  const now = new Date();
  // The SEO card is a courtesy: if the score cache can't be read, the dashboard still renders without it.
  const [data, settings, seo, clock] = await Promise.all([cmsDashboard(me, now), getSiteSettings(), siteSummary().catch(() => null), consoleClock()]);
  const hour = clock.parts(now).hour;
  return { data, settings, seo, clock, todayKey: clock.dateKey(now), greeting: hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening" };
}

/**
 * The CMS's front page: a welcome, the site's content in four figures (each a link to the list behind
 * it), what the viewer was working on, what the team did last, the site's SEO score in brief (SEO
 * Intelligence has the rest), and — for a new team — the few things
 * that turn the placeholder site into theirs. It changes nothing itself; every fix is one click away on
 * the page that owns it, and only the roles that may make that fix are pointed at it.
 */
export default async function CmsDashboardPage() {
  const session = await cmsPage(CMS_PAGE_ROLES.dashboard);
  const me = session.user;
  const caps = cmsCapsFor(me.role);
  const { data, settings, seo, clock, todayKey, greeting } = await loadDashboard(me);
  const siteHost = new URL(siteOrigin()).host;
  const firstName = me.name.trim().split(/\s+/)[0] || me.name;
  const drafts = data.pages.drafts + data.posts.drafts;
  const feed = activityFeedItems(data.recent, { canOpenUsers: caps.admin, canOpenSecurity: caps.admin, canOpenRedirects: caps.publish }, clock);

  return (
    <>
      <PageHeader
        eyebrow={settings.siteName}
        title={`${greeting}, ${firstName}`}
        chips={<CmsRolePill role={me.role} />}
        subtitle={CMS_ROLE_DESCRIPTIONS[me.role]}
        actions={
          caps.write ? (
            <>
              <NewItemButton kind="page" siteHost={siteHost} />
              <NewItemButton kind="post" siteHost={siteHost} />
            </>
          ) : undefined
        }
      />

      <div className="space-y-6">
        <HiddenSiteBanner admin={caps.admin} />
        <GettingStarted setup={data.setup} caps={caps} />

        <KpiGrid columns={4}>
          <KpiTile
            label="Published pages"
            value={num(data.pages.published)}
            icon={<FileText className="h-4 w-4" />}
            tone={data.pages.published > 0 ? "success" : "neutral"}
            href={`${CMS_ROUTES.pages}?view=published`}
            secondary={data.pages.builtinsDefault > 0 ? `${plural(data.pages.builtinsDefault, "built-in page")} still on default content` : "Every built-in page has been published"}
          />
          <KpiTile
            label="Drafts in progress"
            value={num(drafts)}
            icon={<FilePen className="h-4 w-4" />}
            href={`${CMS_ROUTES.pages}?view=drafts`}
            secondary={`${plural(data.pages.drafts, "page")} · ${plural(data.posts.drafts, "post")}`}
          />
          <KpiTile
            label="Scheduled posts"
            value={num(data.posts.scheduled)}
            icon={<Clock className="h-4 w-4" />}
            tone={data.posts.scheduled > 0 ? "info" : "neutral"}
            href={`${CMS_ROUTES.posts}?view=SCHEDULED`}
            secondary={`${plural(data.posts.published, "post")} live on the blog`}
          />
          <KpiTile
            label="New leads this week"
            value={num(data.leads.newThisWeek)}
            icon={<Inbox className="h-4 w-4" />}
            tone={data.leads.newThisWeek > 0 ? "info" : "neutral"}
            href={`${CMS_ROUTES.leads}?status=NEW`}
            secondary={data.leads.newTotal > 0 ? `${num(data.leads.newTotal)} waiting for a reply in all` : "Nobody is waiting for a reply"}
          />
        </KpiGrid>

        <div className="grid items-start gap-6 lg:grid-cols-3">
          <div className="min-w-0 space-y-6 lg:col-span-2">
            <Panel title="Continue editing" description="Your drafts, most recently changed first." padded={data.myDrafts.length === 0}>
              {data.myDrafts.length === 0 ? (
                <EmptyState
                  icon={<PenLine className="h-5 w-5" />}
                  title="Nothing in progress"
                  body={
                    caps.write
                      ? "Pages and posts you start or change show up here until they are published. Start one with New page or New post above."
                      : "Your role reads the site's content; it doesn't write drafts."
                  }
                />
              ) : (
                <ul className="divide-y divide-line">
                  {data.myDrafts.map((draft) => (
                    <li key={`${draft.kind}-${draft.id}`} className="relative flex items-center gap-3 px-5 py-3 hover:bg-surface-sunken">
                      <span aria-hidden="true" className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface-sunken text-muted">
                        {draft.kind === "page" ? <FileText className="h-4 w-4" /> : <Newspaper className="h-4 w-4" />}
                      </span>
                      <div className="min-w-0 flex-1">
                        <Link href={draft.href} className="block truncate text-sm font-medium text-text after:absolute after:inset-0 after:content-[''] hover:text-brand">
                          {draft.title || (draft.kind === "page" ? "Untitled page" : "Untitled post")}
                        </Link>
                        <p className="text-xs text-muted">
                          {draft.kind === "page" ? "Page" : "Post"} · edited <RelativeTime at={draft.updatedAt} />
                        </p>
                      </div>
                      <ArrowRight aria-hidden="true" className="h-4 w-4 shrink-0 text-subtle" />
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel
              title="Recent activity"
              description="What the team changed last."
              footer={
                <Link href={CMS_ROUTES.activity} className="font-medium text-brand hover:underline">
                  See all activity<span aria-hidden="true"> →</span>
                </Link>
              }
            >
              <ActivityFeed items={feed} todayKey={todayKey} showWorkspace={false} empty="Nothing has changed in the CMS yet." />
            </Panel>
          </div>

          <div className="min-w-0 space-y-6">
            <QuickActions caps={caps} />
            <ContentHealth data={data} caps={caps} />
            <SeoCard seo={seo} />
          </div>
        </div>
      </div>
    </>
  );
}

type Setup = { taglinePlaceholder: boolean; homePublished: boolean; settingsPublished: boolean };

/**
 * The few things that make the placeholder site the team's own, while any is left. Each step says
 * who does it: the link is there only for a role that can.
 */
function GettingStarted({ setup, caps }: { setup: Setup; caps: CmsCaps }) {
  const steps = [
    {
      key: "tagline",
      done: !setup.taglinePlaceholder,
      title: "Set your tagline",
      body: "The site still says “Your tagline goes here”. It appears under the name and in the footer.",
      href: caps.publish ? `${CMS_ROUTES.settings}#identity` : null,
      cta: "Open settings",
      who: "An editor or admin sets it.",
    },
    {
      key: "home",
      done: setup.homePublished,
      title: "Publish your home page",
      body: "The home page shows its built-in content until somebody edits and publishes it.",
      href: caps.write ? CMS_ROUTES.builtinPage("home") : null,
      cta: caps.publish ? "Edit and publish" : "Edit the draft",
      who: "A writer drafts it; an editor publishes it.",
    },
    {
      key: "settings",
      done: setup.settingsPublished,
      title: "Publish the site settings",
      body: "Name, contact email, menus and search defaults go live together when the settings are published.",
      href: caps.publish ? CMS_ROUTES.settings : null,
      cta: "Review and publish",
      who: "An editor or admin publishes them.",
    },
  ];
  const done = steps.filter((s) => s.done).length;
  if (done === steps.length) return null;

  return (
    <Panel
      title={
        <span className="inline-flex items-center gap-2">
          <Sparkles aria-hidden="true" className="h-4 w-4 text-brand" />
          Make the site yours
        </span>
      }
      description={`${done} of ${steps.length} done — the site shows placeholders until these are.`}
      actions={
        <div className="w-32">
          <Meter value={done} max={steps.length} label="Getting started" tone="brand" />
        </div>
      }
    >
      <ol className="grid gap-3 md:grid-cols-3">
        {steps.map((step, i) => (
          <li key={step.key} className={cn("flex flex-col gap-2 rounded-lg border p-4", step.done ? "border-success/30 bg-success-bg/40" : "border-line bg-surface")}>
            <div className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className={cn(
                  "grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-semibold",
                  step.done ? "bg-success text-surface" : "border border-line-strong text-muted",
                )}
              >
                {step.done ? <Check className="h-3.5 w-3.5" /> : i + 1}
              </span>
              <h3 className={cn("text-sm font-medium", step.done ? "text-muted line-through decoration-subtle" : "text-text")}>
                {step.title}
                {step.done && <span className="sr-only"> — done</span>}
              </h3>
            </div>
            <p className="text-xs text-muted">{step.body}</p>
            {!step.done &&
              (step.href ? (
                <Link href={step.href} className="mt-auto inline-flex items-center gap-1 text-[13px] font-medium text-brand hover:underline">
                  {step.cta}
                  <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
                </Link>
              ) : (
                <p className="mt-auto text-xs text-subtle">{step.who}</p>
              ))}
          </li>
        ))}
      </ol>
    </Panel>
  );
}

function ActionLink({ href, icon, children }: { href: string; icon: ReactNode; children: ReactNode }) {
  return (
    <li>
      <Link href={href} className="flex items-center gap-2.5 rounded-base px-2 py-2 text-sm text-text transition-colors hover:bg-surface-sunken hover:text-brand">
        <span aria-hidden="true" className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-surface-sunken text-muted">
          {icon}
        </span>
        <span className="min-w-0 flex-1 truncate">{children}</span>
        <ArrowRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-subtle" />
      </Link>
    </li>
  );
}

/** The next things this role is likely to do — nothing it cannot. */
function QuickActions({ caps }: { caps: CmsCaps }) {
  return (
    <Panel title="Quick actions">
      <ul className="-mx-2 space-y-0.5">
        {caps.write && (
          <ActionLink href={CMS_ROUTES.mediaUpload} icon={<ImagePlus className="h-3.5 w-3.5" />}>
            Upload images
          </ActionLink>
        )}
        {caps.publish && (
          <ActionLink href={CMS_ROUTES.navigation} icon={<PanelsTopLeft className="h-3.5 w-3.5" />}>
            Edit the header and footer menus
          </ActionLink>
        )}
        {caps.publish && (
          <ActionLink href={CMS_ROUTES.settings} icon={<Settings className="h-3.5 w-3.5" />}>
            Site name, tagline and contact email
          </ActionLink>
        )}
        <ActionLink href={CMS_ROUTES.leads} icon={<Inbox className="h-3.5 w-3.5" />}>
          {caps.workLeads ? "Work the leads inbox" : "Read the leads inbox"}
        </ActionLink>
        {!caps.write && (
          <ActionLink href={CMS_ROUTES.pages} icon={<FileText className="h-3.5 w-3.5" />}>
            Browse the site&apos;s pages
          </ActionLink>
        )}
        {caps.admin && (
          <ActionLink href={`${CMS_ROUTES.users}?invite=1`} icon={<UserPlus className="h-3.5 w-3.5" />}>
            Invite someone to the CMS
          </ActionLink>
        )}
      </ul>
    </Panel>
  );
}

type Dashboard = Awaited<ReturnType<typeof cmsDashboard>>;

/** Loose ends across the site, each with where it is fixed. Quiet when there are none. */
function ContentHealth({ data, caps }: { data: Dashboard; caps: CmsCaps }) {
  const items = [
    data.pages.changed > 0 && {
      key: "changed",
      icon: <CircleDashed className="h-3.5 w-3.5" />,
      tone: "info" as const,
      text: `${plural(data.pages.changed, "published page")} with changes not yet on the site`,
      href: `${CMS_ROUTES.pages}?view=changed`,
      cta: caps.publish ? "Review and publish" : "See them",
    },
    data.media.needsAlt > 0 && {
      key: "alt",
      icon: <ImageOff className="h-3.5 w-3.5" />,
      tone: "warning" as const,
      text: `${plural(data.media.needsAlt, "image")} without alt text — they can't be published until they have some`,
      href: `${CMS_ROUTES.media}?alt=1`,
      cta: caps.write ? "Add alt text" : "See them",
    },
    data.pages.builtinsDefault > 0 && {
      key: "defaults",
      icon: <Rocket className="h-3.5 w-3.5" />,
      tone: "neutral" as const,
      text: `${plural(data.pages.builtinsDefault, "built-in page")} still showing default content`,
      href: `${CMS_ROUTES.pages}?view=default`,
      cta: "See pages",
    },
    data.leads.newTotal > 0 && {
      key: "leads",
      icon: <Inbox className="h-3.5 w-3.5" />,
      tone: "brand" as const,
      text: `${plural(data.leads.newTotal, "new lead")} waiting for a reply`,
      href: `${CMS_ROUTES.leads}?status=NEW`,
      cta: "Open the inbox",
    },
  ].filter((item): item is Exclude<typeof item, false> => !!item);

  return (
    <Panel title="Needs attention" description={items.length ? undefined : "Nothing is waiting on anybody."}>
      {items.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-success">
          <Check aria-hidden="true" className="h-4 w-4" />
          All tidy.
        </p>
      ) : (
        <ul className="space-y-3">
          {items.map((item) => (
            <li key={item.key} className="flex gap-2.5">
              <span aria-hidden="true" className={cn("mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border", TONE_PILL[item.tone])}>
                {item.icon}
              </span>
              <div className="min-w-0">
                <p className="text-sm text-text">{item.text}</p>
                <Link href={item.href} className="mt-0.5 inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline">
                  {item.cta}
                  <ArrowRight aria-hidden="true" className="h-3 w-3" />
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** The site's SEO score in brief — its number and label, the critical issues — and the way to SEO Intelligence. */
function SeoCard({ seo }: { seo: SeoSiteSummary | null }) {
  const behind = seo ? seo.stale + seo.uncalculated : 0;
  return (
    <Panel
      title={
        <span className="inline-flex items-center gap-2">
          <Gauge aria-hidden="true" className="h-4 w-4 text-muted" />
          SEO
        </span>
      }
      description="Internal indicators, not Google's."
      footer={
        <Link href={CMS_ROUTES.seo} className="font-medium text-brand hover:underline">
          Open SEO Intelligence<span aria-hidden="true"> →</span>
        </Link>
      }
    >
      {!seo || seo.scored === 0 ? (
        <p className="text-sm text-muted">{seo ? "Not calculated yet." : "The scores couldn't be read just now."}</p>
      ) : (
        <div className="space-y-2">
          <ScoreFigure score={seo.overall} label={seo.label} what="Site optimization score" size="md" />
          <p className="text-xs text-muted">
            <Link href={`${CMS_ROUTES.seo}?critical=1&index=indexable`} className={cn("font-medium hover:underline", seo.counts.critical > 0 ? "text-danger" : "text-text")}>
              {plural(seo.counts.critical, "critical issue")}
            </Link>
            {behind > 0 ? ` · ${plural(behind, "score")} to recalculate` : ""}
          </p>
        </div>
      )}
    </Panel>
  );
}
