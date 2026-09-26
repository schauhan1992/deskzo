import { consoleSignOut } from "@/actions/platform/staff-auth";
import { ConsoleNav } from "@/components/console/console-nav";
import { Button } from "@/components/ui/button";
import { consoleStaff } from "@/lib/platform/console-page";

/**
 * The staff console's frame, on admin. only (src/proxy.ts rewrites there into this folder and refuses
 * the folder anywhere else). Each page below checks the session itself too — see consoleStaff.
 */
export default async function ConsoleLayout({ children }: LayoutProps<"/platform-console">) {
  const staff = await consoleStaff();
  return (
    <div className="min-h-screen bg-surface-sunken">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div>
            <p className="text-sm font-semibold text-text">Wroffy platform console</p>
            <p className="text-xs text-muted">
              {staff.name} · {staff.role.toLowerCase()}
            </p>
          </div>
          <form action={consoleSignOut}>
            <Button type="submit" size="sm" variant="ghost">
              Sign out
            </Button>
          </form>
        </div>
        <div className="mx-auto max-w-6xl px-4 pb-2">
          <ConsoleNav />
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
