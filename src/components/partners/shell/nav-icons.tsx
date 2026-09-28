import { Activity, BadgeCheck, Building2, FileSpreadsheet, HandCoins, Handshake, LayoutDashboard, Network, Ticket, UserRound, Users, type LucideIcon } from "lucide-react";
import type { PartnerNavIconName } from "@/lib/partners/nav";
import { cn } from "@/lib/utils";

/**
 * The registry (src/lib/partners/nav.ts) names its icons as strings, so it stays plain data a server
 * page can read without pulling lucide in; this is where the names become glyphs.
 */
const ICONS: Record<PartnerNavIconName, LucideIcon> = {
  LayoutDashboard,
  Building2,
  Ticket,
  Handshake,
  HandCoins,
  FileSpreadsheet,
  Network,
  BadgeCheck,
  Users,
  Activity,
  UserRound,
};

/** A page's icon. Always decorative — the link beside it carries the name. */
export function PartnerNavIcon({ name, className }: { name: PartnerNavIconName; className?: string }) {
  const Icon = ICONS[name] ?? LayoutDashboard;
  return <Icon aria-hidden="true" className={cn("h-4 w-4 shrink-0", className)} />;
}
