import { UrlTabs } from "@/components/console/kit/filters";
import { CMS_ROUTES } from "@/lib/cms/nav";

/**
 * The settings pages as tabs: General, Navigation and — for admins — Security. Real links, so each
 * page loads only its own data and has an address of its own.
 */
export function SettingsTabs({ active, admin }: { active: "general" | "navigation" | "security"; admin: boolean }) {
  const items = [
    { key: "general", label: "General", href: CMS_ROUTES.settings, active: active === "general" },
    { key: "navigation", label: "Navigation", href: CMS_ROUTES.navigation, active: active === "navigation" },
    ...(admin ? [{ key: "security", label: "Security", href: CMS_ROUTES.security, active: active === "security" }] : []),
  ];
  return (
    <div className="mb-6">
      <UrlTabs label="Settings" items={items} />
    </div>
  );
}
