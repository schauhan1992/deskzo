"use client";

import { Activity, FileText, FolderTree, Images, Inbox, LayoutDashboard, Newspaper, PanelsTopLeft, Settings, Signpost, Tags, UserRound, Users, type LucideIcon } from "lucide-react";
import type { CmsNavIconName } from "@/lib/cms/nav";
import { cn } from "@/lib/utils";

/**
 * The registry (src/lib/cms/nav.ts) names its icons as strings, so it stays plain data a server page
 * can read without pulling lucide in; this is where the names become glyphs.
 */
const ICONS: Record<CmsNavIconName, LucideIcon> = {
  LayoutDashboard,
  FileText,
  Newspaper,
  FolderTree,
  Tags,
  Images,
  Inbox,
  PanelsTopLeft,
  Signpost,
  Settings,
  Users,
  Activity,
  UserRound,
};

/** A page's icon. Always decorative — the link beside it carries the name. */
export function CmsNavIcon({ name, className }: { name: CmsNavIconName; className?: string }) {
  const Icon = ICONS[name] ?? LayoutDashboard;
  return <Icon aria-hidden="true" className={cn("h-4 w-4 shrink-0", className)} />;
}
