import { createHash } from "node:crypto";
import { Suspense } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Eye } from "lucide-react";
import { auth, signOut } from "@/lib/auth";
import { db } from "@/lib/db";
import { getCachedSecuritySettings } from "@/lib/security-settings";
import { Button } from "@/components/ui/button";
import { Avatar } from "@/components/ui/avatar";
import { billingNotice } from "@/actions/billing";
import { currentTenant } from "@/lib/tenancy/resolve";
import { canBroadcastNotes } from "@/actions/note";
import { Sidebar } from "@/components/layout/sidebar";
import { SideRail } from "@/components/layout/side-rail";
import { CreateMenu } from "@/components/layout/create-menu";
import { NotificationBell } from "@/components/layout/notification-bell";
import { HeartbeatTracker } from "@/components/layout/heartbeat-tracker";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { getBranding } from "@/actions/branding";
import { getTablePreferences } from "@/actions/table-preference";
import { pendingSplash } from "@/actions/survey";
import { SurveySplash } from "@/components/engagement/survey-splash";
import { TableColumnsProvider } from "@/components/ui/table-columns";
import { WordingProvider } from "@/components/terms/wording-provider";
import { ClockProvider } from "@/components/time/clock-provider";
import { workspaceZone } from "@/lib/time/workspace";
import { getWording } from "@/lib/terms/server";
import { viewAsContext } from "@/lib/session";
import { clearViewAsCookie } from "@/lib/impersonation";
import { listViewAsTargets } from "@/actions/impersonation";
import { ViewAsSwitcher } from "@/components/layout/view-as-switcher";
import { CelebrationSplash } from "@/components/layout/celebration-splash";
import { WishesCorner } from "@/components/layout/wishes-corner";
import { todaysMoments } from "@/lib/hr/today";
import { wishesForLayout } from "@/lib/hr/wishes";
import { getSecurityPolicy } from "@/lib/security/store";
import { dlpApplies, hasAnyDeterrent } from "@/lib/security/policy";
import { recordPageView } from "@/lib/security/page-view";
import { DlpGuard } from "@/components/security/dlp-guard";
import { Watermark } from "@/components/security/watermark";
import { MaintenanceBanner } from "@/components/layout/maintenance-banner";
import { getCopilotAvailability } from "@/actions/copilot";
import { CopilotButton } from "@/components/copilot/copilot-panel";
import { HeaderSearch } from "@/components/layout/header-search";
import { searchScopesForMe } from "@/actions/search";
import { unreadUpdateCounts } from "@/actions/help";
import { can } from "@/lib/authz/resolve";
import { accessContextFor, isModuleEntitled } from "@/lib/modules-access";
import { buildNavigation } from "@/lib/navigation";
import { activeAnnouncementsFor } from "@/lib/platform/announcements";
import { PlatformAnnouncements } from "@/components/platform/platform-announcements";
import { supportLauncherState } from "@/actions/support";
import { getSupportAccess } from "@/actions/support-access";
import { SupportLauncher } from "@/components/support/support-launcher";
import { linkedSignInEnabled } from "@/lib/platform/linked/groups";
import { PLATFORM_DOMAIN } from "@/lib/tenancy/host";
import { WorkspaceSwitcher } from "@/components/linked/workspace-switcher";
import { OnboardingWizard } from "@/components/onboarding/onboarding-wizard";
import { wizardAutoOpens, wizardMounted } from "@/lib/help/onboarding";

/** Nothing unread on either side — for nobody signed in, or a count that could not be read. */
const NO_UNREAD = { deskzo: 0, company: 0 };

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [session, requestHeaders, branding, viewAs, securityPolicy, wording, zone] = await Promise.all([
    auth(),
    headers(),
    getBranding(),
    viewAsContext(),
    getSecurityPolicy(),
    // The workspace's own words (Settings → Wording, src/lib/terms) — the menu's, and every client
    // component's through WordingProvider. Never throws.
    getWording(),
    // The workspace's clock (Settings → Profile, src/lib/time) — every client component's through
    // ClockProvider.
    workspaceZone(),
  ]);
  // While viewing as someone else, every chrome element below describes them, not the admin — the
  // point of the feature is to see their app, and a header still showing the admin's name and role
  // would make it impossible to tell whose permissions a page was rendered with.
  const shownUser = viewAs?.user ?? session?.user;
  /**
   * What this person may open — the plan, the company's switches and their permissions, resolved
   * once for the request and for whoever it is acting as, so an admin viewing as a salesperson sees
   * the salesperson's menu. The sidebar, the Create menu and the rail are drawn from it; the pages
   * and actions they lead to ask the same rule again (src/lib/navigation.ts). Read fresh on every
   * request, so a permission taken away is gone from the menu on the next page.
   */
  const [access, viewAsTargets, tablePreferences, canBroadcast, splash, copilot, searchScopes, unreadUpdates, canManageHelp, supportLauncher, supportAccess] = await Promise.all([
    shownUser ? accessContextFor(shownUser.id) : Promise.resolve(null),
    listViewAsTargets(),
    // One read for every table on every page — see src/components/ui/table-columns.tsx for why this
    // is hoisted rather than fetched per table.
    getTablePreferences(),
    // Whether the Create menu's note composer offers "Everyone". `canBroadcastNotes` resolves the
    // acting user through `requireUser`, so it already follows "view as" — but it throws when
    // nobody is signed in, and this layout renders in that case rather than redirecting.
    shownUser ? canBroadcastNotes() : Promise.resolve(false),
      // The skip is per session, so nothing is passed in: a dismissal the server remembered would
    // make "not now" permanent, which is the opposite of what a mandatory form needs.
    isModuleEntitled("engagement").then((has) => (has ? pendingSplash([]) : null)),
    // Not while viewing as somebody: a copilot chat is private, and would open as theirs.
    shownUser && !viewAs ? getCopilotAvailability().catch(() => null) : Promise.resolve(null),
    // The header search offers only the lists this person can open — src/actions/search.ts. Like
    // the sidebar, it follows "view as".
    shownUser ? searchScopesForMe().catch(() => []) : Promise.resolve([]),
    // What's new, Deskzo's and the company's counted apart (src/actions/help.ts): the rail gives each its
    // own dot. Deskzo's side is a minute-long shared copy that never throws, so it costs a page nothing.
    shownUser ? unreadUpdateCounts().catch(() => NO_UNREAD) : Promise.resolve(NO_UNREAD),
    shownUser ? can(shownUser.id, "help.manage") : Promise.resolve(false),
    // The platform's Contact Support button — null for a view-as, platform support staff, or support
    // switched off. Never throws, and reads its settings from a minute-long copy with a 1.5 s limit,
    // so a slow control plane costs a page nothing (src/actions/support.ts).
    session?.user && !viewAs ? supportLauncherState() : Promise.resolve(null),
    // The rail's door for Deskzo support — the super admin's alone, null for everybody else
    // (src/actions/support-access.ts). A control plane out of reach only hides the button.
    session?.user && !viewAs ? getSupportAccess().catch(() => null) : Promise.resolve(null),
]);

  const permissions: string[] = access?.permissions ?? [];
  const openModules = access?.openModules ?? [];
  const navigation = access ? buildNavigation(access) : [];

  // Not while viewing as somebody else: an admin borrowing an account should not be wished a happy
  // birthday on their behalf, and dismissing it would mark it seen for a person who never saw it.
  const today = viewAs ? null : await todaysMoments();
  // Wishes on the shown person's birthday or work anniversary today — an admin viewing as them sees
  // theirs, read-only. Empty on any other day; never throws (src/lib/hr/wishes.ts).
  const wishes = shownUser ? await wishesForLayout(shownUser.id) : [];
  // The owner's reminder while a trial or a grace period runs — null for everybody else.
  const billing = session?.user && !viewAs ? await billingNotice().catch(() => null) : null;
  // The platform's announcements for this workspace. Cached for a minute and never throws, so a
  // control plane that is down or slow costs a page nothing (src/lib/platform/announcements.ts).
  const announcements = session?.user ? await activeAnnouncementsFor(await currentTenant()) : [];

  const currentPath = requestHeaders.get("x-pathname") ?? "";
  // Skipped while viewing as someone else: "you must change your password" is about the person
  // signed in, and forcing an admin into a borrowed account's password form would be both useless
  // and the start of an account takeover.
  // Read on /profile too, where the redirect lands: the onboarding wizard stays shut over that form.
  let forcedSetup = false;
  if (session?.user && !viewAs) {
    const [dbUser, security] = await Promise.all([
      db.user.findUnique({
        where: { id: session.user.id },
        select: { mustChangePassword: true, twoFactorEnabledAt: true },
      }),
      getCachedSecuritySettings(),
    ]);
    const needsTwoFactorSetup = !!security?.enforceTwoFactor && !dbUser?.twoFactorEnabledAt;
    forcedSetup = !!dbUser?.mustChangePassword || needsTwoFactorSetup;
    if (forcedSetup && !currentPath.startsWith("/profile")) {
      redirect("/profile");
    }
  }

  // Resolved against whoever the request is acting as, so an admin viewing as a salesperson sees
  // the salesperson's restrictions. That is the point of "view as" — an admin who wants to know
  // why somebody cannot copy an order number should experience it, not read about it.
  // The session token has no photo marker on it, so it is read here. One tiny column, and it
  // resolves against whoever the request is acting as — an admin viewing as somebody should see
  // that person's face in the header, for the same reason the name and role already change.
  // The same read carries the account's kind, for the workspace switcher below.
  const viewer = shownUser
    ? await db.user.findUnique({ where: { id: shownUser.id }, select: { photoUpdatedAt: true, kind: true, onboardingCompletedAt: true } })
    : null;
  const viewerPhotoUpdatedAt = viewer?.photoUpdatedAt ?? null;
  // Linked sign-in's workspace switcher (spec §2.1): the person's own member account only — never while
  // viewing as somebody (then `viewer` is them), never a platform support account — and only while the
  // platform's switch is on, which it never is without a control plane. That answer is cached for 30 s;
  // the list itself is asked for only when the switcher is opened.
  const canSwitch = !viewAs && !!session?.user && viewer?.kind === "MEMBER" && (await linkedSignInEnabled());

  const dlpOn = dlpApplies(shownUser?.role, securityPolicy) && hasAnyDeterrent(securityPolicy);

  // The Getting Started wizard (src/lib/help/onboarding.ts): for a person still being onboarded, signed in as
  // themselves; never while viewing as somebody (then `viewer` is them). It opens by itself once per sign-in — the
  // key names the sign-in without carrying its id to the page — except over a forced password or two-factor form.
  const onboardingGate = { person: viewer, viewingAs: !!viewAs, forcedSetup };
  const onboarding =
    session?.user && wizardMounted(onboardingGate)
      ? {
          autoOpen: wizardAutoOpens(onboardingGate),
          signInKey: createHash("sha256").update(`onboarding|${session.user.sid ?? session.user.id}`).digest("hex").slice(0, 16),
        }
      : null;

  // Only when the admin has asked for it — see recordPageView. Not awaited: a page must not wait on
  // its own audit trail, and the write is throttled so a burst of navigation is one row anyway.
  if (shownUser && currentPath) {
    void recordPageView({
      userId: shownUser.id,
      userName: shownUser.name,
      role: shownUser.role,
      path: currentPath,
    });
  }

  return (
    <TableColumnsProvider initial={tablePreferences}>
    <WordingProvider initial={wording}>
    <ClockProvider zone={zone}>
    <div className="flex min-h-screen bg-bg">
      {/* Not while impersonating: the heartbeat accrues "time spent on the CRM" against whoever the
          request resolves as, and an admin reading somebody's screen is not that person working. */}
      {!viewAs && <HeartbeatTracker />}

      {/* Never while impersonating: putting a mandatory form in front of an admin who is viewing as
          somebody else would record an answer from the wrong person, on a form that cannot be
          answered twice. */}
      {!viewAs && splash && <SurveySplash pending={splash} />}

      {onboarding && <OnboardingWizard autoOpen={onboarding.autoOpen} signInKey={onboarding.signInKey} />}

      {dlpOn && (
        <>
          <DlpGuard
            policy={{
              blockCopy: securityPolicy.blockCopy,
              blockCut: securityPolicy.blockCut,
              blockPaste: securityPolicy.blockPaste,
              blockContextMenu: securityPolicy.blockContextMenu,
              blockTextSelection: securityPolicy.blockTextSelection,
              blockPrint: securityPolicy.blockPrint,
              blockDevTools: securityPolicy.blockDevTools,
              blurOnBlur: securityPolicy.blurOnBlur,
              screenshotLimitPerDay: securityPolicy.screenshotLimitPerDay,
            }}
          />
          {securityPolicy.watermarkEnabled && shownUser && (
            <Watermark
              // The address as well as the name: two people called Amit make a name-only watermark
              // useless at exactly the moment it is needed.
              label={`${shownUser.name} · ${shownUser.email}`}
              opacity={securityPolicy.watermarkOpacity}
              scope={securityPolicy.watermarkScope}
            />
          )}
        </>
      )}
      <Sidebar navigation={navigation} branding={branding} support={!!supportLauncher} />

      <div className={`flex min-w-0 flex-1 flex-col${viewAs ? " ring-2 ring-inset ring-warning/50" : ""}`}>
        {/* Sticky so the controls stay reachable when a long table scrolls. */}
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-surface/85 px-4 backdrop-blur-md md:px-6">
          {/* Leaves room for the mobile menu button, which floats over this corner. */}
          <div className="w-9 shrink-0 md:hidden" />
          {searchScopes.length > 0 && <HeaderSearch scopes={searchScopes} />}
          {viewAs && (
            <span className="flex min-w-0 items-center gap-1.5 rounded-full bg-warning-bg px-2.5 py-1 text-xs font-medium text-warning">
              <Eye className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">
                Viewing as {viewAs.user.name}
                <span className="hidden sm:inline"> · you are {viewAs.actor.name}</span>
              </span>
            </span>
          )}
          <div className="ml-auto flex items-center gap-2 md:gap-3">
            {canSwitch && (
              <WorkspaceSwitcher
                // The workspace's own name, as the panel lists every workspace: an unbranded workspace's app
                // name is the product's default, the same for all of them, and a switcher can't tell them apart.
                // Initials come from that name too (blank lets the mark work them out).
                current={{ name: (await currentTenant()).name, initials: "", logoDataUrl: branding.logoDataUrl }}
                domain={PLATFORM_DOMAIN}
              />
            )}
            {/* Resolved for whoever the request is acting as, like everything else in this header —
                an admin viewing as a salesperson should be offered the salesperson's options. */}
            <CreateMenu
              openModules={openModules}
              permissions={permissions}
              canBroadcastNotes={canBroadcast}
            />
            <ViewAsSwitcher
              targets={viewAsTargets}
              viewingAs={viewAs ? { userName: viewAs.user.name, actorName: viewAs.actor.name } : null}
            />
            {copilot && <CopilotButton availability={copilot} />}
            <ThemeToggle defaultTheme={branding.defaultTheme} />
            <NotificationBell />
            <Link
              href="/profile"
              className="group flex items-center gap-2 rounded-base px-1.5 py-1 transition-colors hover:bg-surface-sunken"
            >
              <Avatar
                user={shownUser ? { id: shownUser.id, name: shownUser.name, photoUpdatedAt: viewerPhotoUpdatedAt } : null}
                size="sm"
                tone={viewAs ? "warning" : "default"}
              />
              <span className="hidden text-left leading-tight sm:block">
                <span className="block text-[13px] font-medium text-text">{shownUser?.name}</span>
                <span className="block text-[11px] text-subtle">{shownUser?.role}</span>
              </span>
            </Link>
            <form
              action={async () => {
                "use server";
                // Cleared first: the ticket is bound to this admin's id, so leaving it behind would
                // put the next sign-in straight back into somebody else's account.
                await clearViewAsCookie();
                await signOut({ redirectTo: "/login" });
              }}
            >
              <Button type="submit" variant="ghost" size="sm">
                Sign out
              </Button>
            </form>
          </div>
        </header>
        <MaintenanceBanner />
        {/*
          The platform's banners sit above <main>, not inside it: a page may bleed its header into
          main's top padding with negative margins (the dashboard's welcome header does), which would
          pull it over anything placed first inside main. Their spacing is their own margins, so a
          banner dismissed or absent leaves no gap.
        */}
        <div className="mx-auto w-full max-w-[1600px] px-4 md:px-6">
          <PlatformAnnouncements items={announcements} />
          {billing && (
            <Link
              href="/settings/billing"
              className={`my-4 block rounded-base border px-3 py-2 text-sm md:my-6 ${billing.tone === "warning" ? "border-warning/40 bg-warning-bg text-warning" : "border-info/30 bg-info-bg text-info"}`}
            >
              {billing.text} <span className="font-medium underline">Plan &amp; billing</span>
            </Link>
          )}
        </div>
        <main className="mx-auto w-full max-w-[1600px] flex-1 animate-fade-rise px-4 py-6 md:px-6 md:py-8">{children}</main>
        {today && <CelebrationSplash moments={today.moments} />}
        {wishes.length > 0 && (
          <Suspense fallback={null}>
            <WishesCorner initial={wishes} readOnly={!!viewAs} />
          </Suspense>
        )}
      </div>

      {/*
        Hidden below `xl`. On a laptop the content column is already the narrow part, and taking
        another twenty rem out of it to hold a calculator would make every table worse in exchange
        for a convenience. The tools it offers all have pages of their own.
      */}
      <div className="hidden xl:block">
        <SideRail
          copilot={!!copilot}
          unreadUpdates={unreadUpdates.company}
          unreadDeskzoUpdates={unreadUpdates.deskzo}
          canManageHelp={canManageHelp}
          // The name it was registered under heads the company's own guides. A workspace read from the
          // environment may be named only by its slug, so it keeps "From your company".
          companyName={(await currentTenant()).source === "control" ? (await currentTenant()).name : null}
          // It lists a customer's subscriptions and what each was sold at, so it needs "View orders";
          // its Create proposal button needs "Raise and issue sales documents" (owner, 8 Oct 2026).
          proRata={(await isModuleEntitled("renewals")) && permissions.includes("orders.view")}
          proRataProposals={(await isModuleEntitled("sales_documents")) && permissions.includes("documents.issue")}
          // The rail's tasks and notes are those modules' — not offered where their pages aren't.
          tasks={openModules.includes("tasks")}
          notes={openModules.includes("notes")}
          country={(await currentTenant()).country}
          support={!!supportLauncher}
          supportAccess={supportAccess ? { inside: !!supportAccess.grant } : null}
        />
      </div>

      {/* The Contact Support dialog; its button is on the tool rail from xl, and at the foot of the sidebar below it. */}
      {supportLauncher && <SupportLauncher state={supportLauncher} />}
    </div>
    </ClockProvider>
    </WordingProvider>
    </TableColumnsProvider>
  );
}
