import { ConsoleShell } from "@/components/console/shell/console-shell";
import { ClockProvider } from "@/components/time/clock-provider";
import { consoleZone } from "@/lib/platform/console-clock";
import { schemaLabel } from "@/lib/console-shared/labels";
import { pagesFor } from "@/lib/console-shared/nav";
import { consoleStaff, platformEnv } from "@/lib/platform/console-page";
import { navCounts } from "@/lib/platform/nav-counts";
import { workspaceMigrationNames } from "@/lib/platform/schema-info";

/**
 * The staff console's frame, on admin. only (src/proxy.ts rewrites there into this folder and refuses
 * the folder anywhere else). Each page below checks the session itself too — see consoleStaff: the App
 * Router keeps this layout across navigations without running it again.
 *
 * Everything the shell shows is worked out here, on the server, as plain props: the pages this role may
 * open (the same registry the page gates read), the sidebar's badge counts (`navCounts` never throws — a
 * badge it cannot count is left off), which installation this is, and the newest workspace schema this
 * code carries, in words ("billing · 28 Sep").
 */
export default async function ConsoleLayout({ children }: LayoutProps<"/platform-console">) {
  const staff = await consoleStaff();
  const env = platformEnv();
  const visibleKeys = pagesFor(staff.role).map((page) => page.key);
  const [counts, zone] = await Promise.all([navCounts(staff.role), consoleZone()]);
  // The folder read that never throws (an unreadable folder is "none", not a broken console).
  const schema = schemaLabel(workspaceMigrationNames().at(-1) ?? null);

  return (
    // The console's clock (Settings › Time zone) — every client component's through ClockProvider.
    <ClockProvider zone={zone}>
      <ConsoleShell staff={{ name: staff.name, email: staff.email, role: staff.role }} env={env} visibleKeys={visibleKeys} counts={counts} schema={schema}>
        {children}
      </ConsoleShell>
    </ClockProvider>
  );
}
