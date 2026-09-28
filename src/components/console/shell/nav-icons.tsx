"use client";

import {
  BellRing,
  Building2,
  CreditCard,
  DatabaseZap,
  Earth,
  FingerprintPattern,
  Globe,
  HandCoins,
  Handshake,
  HeartPulse,
  Hourglass,
  Layers,
  LayoutDashboard,
  LifeBuoy,
  Megaphone,
  Rocket,
  ScrollText,
  Settings,
  Ticket,
  UserPlus,
  UserRound,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { NavIconName } from "@/lib/console-shared/nav";
import { cn } from "@/lib/utils";

/**
 * The registry (src/lib/console-shared/nav.ts) names its icons as strings, so it stays a plain data
 * module a server page can read without pulling lucide in; this is where the names become glyphs.
 * "Fingerprint" is lucide's older name for FingerprintPattern — the alias still exists but is the one
 * a lucide upgrade drops, so the map points at the new name.
 */
const ICONS: Record<NavIconName, LucideIcon> = {
  LayoutDashboard,
  BellRing,
  Building2,
  LifeBuoy,
  Hourglass,
  UserPlus,
  Ticket,
  Handshake,
  Megaphone,
  CreditCard,
  HandCoins,
  Layers,
  HeartPulse,
  Rocket,
  DatabaseZap,
  Fingerprint: FingerprintPattern,
  Earth,
  Globe,
  Users,
  ScrollText,
  Settings,
  UserRound,
};

/** A page's icon. Always decorative — the link beside it carries the name. */
export function NavIcon({ name, className }: { name: NavIconName; className?: string }) {
  const Icon = ICONS[name] ?? LayoutDashboard;
  return <Icon aria-hidden="true" className={cn("h-4 w-4 shrink-0", className)} />;
}
