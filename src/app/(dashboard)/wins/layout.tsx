import { currentUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { isModuleEnabled } from "@/actions/module";
import { WinsTabs } from "@/components/wins/wins-tabs";

/** The tabs above every wins page. Each page still checks what it shows; this only offers the links. */
export default async function WinsLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  const [on, canManage] = await Promise.all([isModuleEnabled("wins"), user ? can(user.id, "wins.manage") : Promise.resolve(false)]);
  if (!on) return <>{children}</>;
  return (
    <div className="animate-fade-rise">
      <WinsTabs canManage={canManage} />
      {children}
    </div>
  );
}
