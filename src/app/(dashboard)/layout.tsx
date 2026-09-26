import { headers } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Eye } from "lucide-react";
import { auth, signOut } from "@/lib/auth";
import { db } from "@/lib/db";
import { getCachedSecuritySettings } from "@/lib/security-settings";
import { Button } from "@/components/ui/button";
import { Avatar } from "@/components/ui/avatar";
import { getModuleStates } from "@/actions/module";
import { billingNotice } from "@/actions/billing";
import { currentTenant } from "@/lib/tenancy/resolve";
import { canViewPerformance } from "@/actions/performance";
import { navPermissions } from "@/actions/permission";
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
import { viewAsContext } from "@/lib/session";
import { clearViewAsCookie } from "@/lib/impersonation";
import { listViewAsTargets } from "@/actions/impersonation";
import { ViewAsSwitcher } from "@/components/layout/view-as-switcher";
import { CelebrationSplash } from "@/components/layout/celebration-splash";
import { todaysMoments } from "@/lib/hr/today";
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
import { unreadUpdateCount } from "@/actions/help";
import { can } from "@/lib/authz/resolve";
import { isModuleEntitled } from "@/lib/modules-access";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [session, modules, requestHeaders, canSeePerformance, branding, viewAs, securityPolicy] = await Promise.all([
    auth(),
    getModuleStates(),
    headers(),
    canViewPerformance(),
    getBranding(),
    viewAsContext(),
    getSecurityPolicy(),
  ]);
  const enabledKeys = modules.filter((m) => m.enabled).map((m) => m.key);

  // While viewing as someone else, every chrome element below describes them, not the admin — the
  // point of the feature is to see their app, and a header still showing the admin's name and role
  // would make it impossible to tell whose permissions a page was rendered with.
  const shownUser = viewAs?.user ?? session?.user;
  const [viewAsTargets, permissions, tablePreferences, canBroadcast, splash, copilot, searchScopes, unreadUpdates, canManageHelp] = await Promise.all([
    listViewAsTargets(),
    // Resolved for whoever the request is acting as, so an admin viewing as a salesperson sees
    // the salesperson's sidebar rather than their own.
    shownUser ? navPermissions(shownUser.id) : Promise.resolve([]),
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
    shownUser ? unreadUpdateCount().catch(() => 0) : Promise.resolve(0),
    shownUser ? can(shownUser.id, "help.manage") : Promise.resolve(false),
]);

  // Not while viewing as somebody else: an admin borrowing an account should not be wished a happy
  // birthday on their behalf, and dismissing it would mark it seen for a person who never saw it.
  const today = viewAs ? null : await todaysMoments();
  // The owner's reminder while a trial or a grace period runs — null for everybody else.
  const billing = session?.user && !viewAs ? await billingNotice().catch(() => null) : null;

  const currentPath = requestHeaders.get("x-pathname") ?? "";
  // Skipped while viewing as someone else: "you must change your password" is about the person
  // signed in, and forcing an admin into a borrowed account's password form would be both useless
  // and the start of an account takeover.
  if (session?.user && !viewAs && !currentPath.startsWith("/profile")) {
    const [dbUser, security] = await Promise.all([
      db.user.findUnique({
        where: { id: session.user.id },
        select: { mustChangePassword: true, twoFactorEnabledAt: true },
      }),
      getCachedSecuritySettings(),
    ]);
    const needsTwoFactorSetup = !!security?.enforceTwoFactor && !dbUser?.twoFactorEnabledAt;
    if (dbUser?.mustChangePassword || needsTwoFactorSetup) {
      redirect("/profile");
    }
  }

  // Resolved against whoever the request is acting as, so an admin viewing as a salesperson sees
  // the salesperson's restrictions. That is the point of "view as" — an admin who wants to know
  // why somebody cannot copy an order number should experience it, not read about it.
  // The session token has no photo marker on it, so it is read here. One tiny column, and it
  // resolves against whoever the request is acting as — an admin viewing as somebody should see
  // that person's face in the header, for the same reason the name and role already change.
  const viewerPhotoUpdatedAt = shownUser
    ? (await db.user.findUnique({ where: { id: shownUser.id }, select: { photoUpdatedAt: true } }))?.photoUpdatedAt ?? null
    : null;

  const dlpOn = dlpApplies(shownUser?.role, securityPolicy) && hasAnyDeterrent(securityPolicy);

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
    <div className="flex min-h-screen bg-bg">
      {/* Not while impersonating: the heartbeat accrues "time spent on the CRM" against whoever the
          request resolves as, and an admin reading somebody's screen is not that person working. */}
      {!viewAs && <HeartbeatTracker />}

      {/* Never while impersonating: putting a mandatory form in front of an admin who is viewing as
          somebody else would record an answer from the wrong person, on a form that cannot be
          answered twice. */}
      {!viewAs && splash && <SurveySplash pending={splash} />}

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
            />
          )}
        </>
      )}
      <Sidebar
        enabledKeys={enabledKeys}
        canViewPerformance={canSeePerformance}
        permissions={permissions}
        branding={branding}
        country={(await currentTenant()).country}
      />

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
            {/* Resolved for whoever the request is acting as, like everything else in this header —
                an admin viewing as a salesperson should be offered the salesperson's options. */}
            <CreateMenu
              enabledKeys={enabledKeys}
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
        <main className="mx-auto w-full max-w-[1600px] flex-1 animate-fade-rise px-4 py-6 md:px-6 md:py-8">
          {billing && (
            <Link
              href="/settings/billing"
              className={`mb-4 block rounded-base border px-3 py-2 text-sm ${billing.tone === "warning" ? "border-warning/40 bg-warning-bg text-warning" : "border-info/30 bg-info-bg text-info"}`}
            >
              {billing.text} <span className="font-medium underline">Plan &amp; billing</span>
            </Link>
          )}
          {children}
        </main>
        {today && <CelebrationSplash moments={today.moments} />}
      </div>

      {/*
        Hidden below `xl`. On a laptop the content column is already the narrow part, and taking
        another twenty rem out of it to hold a calculator would make every table worse in exchange
        for a convenience. The tools it offers all have pages of their own.
      */}
      <div className="hidden xl:block">
        <SideRail
          copilot={!!copilot}
          unreadUpdates={unreadUpdates}
          canManageHelp={canManageHelp}
          proRata={await isModuleEntitled("renewals")}
          country={(await currentTenant()).country}
        />
      </div>
    </div>
    </TableColumnsProvider>
  );
}
