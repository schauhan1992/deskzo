"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { BadgeCheck, CalendarDays, CalendarRange, Calculator, CheckSquare, CircleHelp, Coins, Headset, Megaphone, MessageCircle, MonitorPlay, ShieldCheck, Sparkles, StickyNote, X } from "lucide-react";
import { COPILOT_OPEN_EVENT, SIDE_RAIL_STORAGE_KEY, UPDATES_SEEN_EVENT, parseTool, type SideRailTool } from "@/lib/side-rail";
import { RailTasks } from "@/components/layout/rail-tasks";
import { RailCalendar } from "@/components/layout/rail-calendar";
import { RailNotes } from "@/components/layout/rail-notes";
import { RailCalculator } from "@/components/layout/rail-calculator";
import { RailCurrency } from "@/components/layout/rail-currency";
import { RailLookup } from "@/components/layout/rail-lookup";
import { RailProRata } from "@/components/layout/rail-prorata";
import { RailHelp, RailUpdates, RailVideos } from "@/components/layout/rail-help";
import { openSupport } from "@/components/support/open-support";
import { RailSupportAccess } from "@/components/layout/rail-support-access";
import { ChatApp } from "@/components/chat/chat-app";
import { useChatLive } from "@/components/chat/chat-live";

const TOOLS: { key: SideRailTool; label: string; icon: typeof Calculator; group: "work" | "help" }[] = [
  { key: "chat", label: "Chat", icon: MessageCircle, group: "work" },
  { key: "tasks", label: "My tasks", icon: CheckSquare, group: "work" },
  { key: "calendar", label: "My calendar", icon: CalendarDays, group: "work" },
  { key: "notes", label: "Sticky notes", icon: StickyNote, group: "work" },
  { key: "calculator", label: "GST & margin", icon: Calculator, group: "work" },
  { key: "prorata", label: "Pro-rata", icon: CalendarRange, group: "work" },
  { key: "currency", label: "Currency", icon: Coins, group: "work" },
  { key: "lookup", label: "GSTIN check", icon: BadgeCheck, group: "work" },
  { key: "updates", label: "What's new", icon: Megaphone, group: "help" },
  { key: "help", label: "Help", icon: CircleHelp, group: "help" },
  { key: "videos", label: "Video walkthroughs", icon: MonitorPlay, group: "help" },
  { key: "support-access", label: "Deskzo support access", icon: ShieldCheck, group: "help" },
];

/**
 * The tool rail, down the right-hand edge.
 *
 * Read through `useSyncExternalStore` rather than during render. `localStorage` is browser-only, so
 * touching it while rendering gives the server one answer and the client another — which is the
 * hydration mismatch this codebase has already been bitten by once, in the theme toggle. The server
 * snapshot is "closed", so the first paint is always the rail alone and the panel opens after
 * mount; nothing shifts unless the reader had actually left one open.
 *
 * The panel sits beside the content rather than over it. A tool you need *while* reading something
 * is no use if it covers the thing you were reading, which is the whole reason it is not a modal.
 */
export function SideRail({
  copilot = false,
  unreadUpdates = 0,
  unreadDeskzoUpdates = 0,
  canManageHelp = false,
  companyName = null,
  proRata = true,
  proRataProposals = false,
  tasks = true,
  calendar = false,
  notes = true,
  country = "IN",
  support = false,
  supportAccess = null,
  chat = false,
}: {
  /** Chat is open to this person, as themselves — its panel and its unread count (src/components/chat). */
  chat?: boolean;
  /** Renewals are in the workspace's plan — the pro-rata tool quotes seats onto a subscription. */
  proRata?: boolean;
  /** This person may raise a proposal — the pro-rata panel then offers to draft one from its figures. */
  proRataProposals?: boolean;
  /** The person may open Tasks / Calendar / Sticky Notes — the rail's panels are those modules'. */
  tasks?: boolean;
  calendar?: boolean;
  notes?: boolean;
  /** The workspace's: the GST calculator and the GSTIN check are India's. */
  country?: string;
  /** The copilot is on and this person may use it — the rail then offers it beside Help. */
  copilot?: boolean;
  /** The company's news they have not seen, for its dot on the What's new button. */
  unreadUpdates?: number;
  /** Deskzo's What's new they have not seen — a dot of its own, never added to the company's. */
  unreadDeskzoUpdates?: number;
  canManageHelp?: boolean;
  /** The company's name, for the heading over its own guides and videos ("From Acme Traders"); null: "From your company". */
  companyName?: string | null;
  /** Offer Contact Support — the layout's answer from `supportLauncherState()`. */
  support?: boolean;
  /**
   * The super admin's door for Deskzo support (owner, 2 Oct 2026): null for everybody else, who never
   * sees the button; `inside` while support can see the workspace, which puts a dot on it.
   */
  supportAccess?: { inside: boolean } | null;
}) {
  const open = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const chatUnread = useChatLive()?.unread ?? 0;

  // The server's counts, until What's new is opened — then each cleared at once by its own feed,
  // rather than on the next page load. New counts from the server (a new post, another page) replace them.
  const [unread, setUnread] = useState({ deskzo: unreadDeskzoUpdates, company: unreadUpdates });
  const [unreadFrom, setUnreadFrom] = useState({ deskzo: unreadDeskzoUpdates, company: unreadUpdates });
  if (unreadDeskzoUpdates !== unreadFrom.deskzo || unreadUpdates !== unreadFrom.company) {
    setUnreadFrom({ deskzo: unreadDeskzoUpdates, company: unreadUpdates });
    setUnread({ deskzo: unreadDeskzoUpdates, company: unreadUpdates });
  }
  useEffect(() => {
    // The feed that was opened says whose posts it marked (src/components/help/recent-updates.tsx);
    // an event that says nothing is the company's, as it always was.
    const clear = (event: Event) => {
      const source = event instanceof CustomEvent ? event.detail : null;
      setUnread((u) => (source === "deskzo" ? { ...u, deskzo: 0 } : { ...u, company: 0 }));
    };
    window.addEventListener(UPDATES_SEEN_EVENT, clear);
    return () => window.removeEventListener(UPDATES_SEEN_EVENT, clear);
  }, []);

  const choose = useCallback((tool: SideRailTool) => {
    try {
      const next = getSnapshot() === tool ? null : tool;
      if (next) window.localStorage.setItem(SIDE_RAIL_STORAGE_KEY, next);
      else window.localStorage.removeItem(SIDE_RAIL_STORAGE_KEY);
    } catch {
      // Private browsing, or storage turned off. The rail still works for this page view; the
      // choice simply is not remembered, which is a better outcome than the click doing nothing.
    }
    window.dispatchEvent(new Event(SIDE_RAIL_STORAGE_KEY));
  }, []);

  // Escape closes it, like every other dismissible thing in this app.
  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") choose(open!);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, choose]);

  // Only the tools this workspace has: nothing here asks for a module outside its plan.
  const tools = TOOLS.filter(
    (t) => (t.key !== "prorata" || proRata) && (t.key !== "tasks" || tasks) && (t.key !== "calendar" || calendar) && (t.key !== "notes" || notes) && ((t.key !== "calculator" && t.key !== "lookup") || country === "IN") && (t.key !== "support-access" || !!supportAccess) && (t.key !== "chat" || chat),
  );
  const active = tools.find((t) => t.key === open);

  return (
    /*
      Runs from the very top rather than starting under the header.

      Sitting below it left a band of page background in the top-right corner, beside the header
      but not part of it, which read as something failing to load. The rail now spans the full
      height and repeats the header's own height and bottom border across itself, so the line under
      the header runs unbroken to the edge of the window and the corner belongs to something.
    */
    <div className="sticky top-0 z-20 flex h-screen shrink-0 border-l border-line bg-surface">
      {active && (
        <aside
          aria-label={active.label}
          className={`flex flex-col overflow-hidden border-r border-line ${active.key === "chat" ? "w-80 2xl:w-96" : "w-72 lg:w-80"}`}
        >
          {/* Its title bar lines up with the app header rather than starting below it. */}
          <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-line px-3">
            <span className="text-sm font-medium text-text">{active.label}</span>
            <button
              type="button"
              onClick={() => choose(active.key)}
              aria-label="Close"
              className="rounded-base p-1 text-muted hover:bg-surface-sunken hover:text-text"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className={active.key === "chat" ? "min-h-0 flex-1" : "min-h-0 flex-1 overflow-y-auto p-3"}>
            {active.key === "chat" && <ChatApp compact />}
            {active.key === "tasks" && <RailTasks />}
            {active.key === "calendar" && <RailCalendar />}
            {active.key === "notes" && <RailNotes />}
            {active.key === "calculator" && <RailCalculator />}
            {active.key === "prorata" && <RailProRata canPropose={proRataProposals} />}
            {active.key === "currency" && <RailCurrency />}
            {active.key === "lookup" && <RailLookup />}
            {active.key === "updates" && <RailUpdates canManage={canManageHelp} />}
            {active.key === "help" && <RailHelp canManage={canManageHelp} companyName={companyName} />}
            {active.key === "videos" && <RailVideos canManage={canManageHelp} companyName={companyName} />}
            {active.key === "support-access" && <RailSupportAccess inside={!!supportAccess?.inside} />}
          </div>
        </aside>
      )}

      <nav aria-label="Tools" className="flex w-12 shrink-0 flex-col items-center gap-1">
        {/* The header’s height and its border, continued. */}
        <div className="h-14 w-full shrink-0 border-b border-line" />
        <div className="flex flex-col items-center gap-1 py-2">
        {tools.map((tool, index) => {
          const Icon = tool.icon;
          const isOpen = open === tool.key;
          // What's new carries two dots, one per source, each saying its own count — never one sum.
          const news = tool.key === "updates" ? unread : null;
          // Support access says so while support is inside: the one thing on this rail that is about who else can see.
          const supportIn = tool.key === "support-access" && !!supportAccess?.inside;
          const label = news ? withNews(tool.label, news) : supportIn ? `${tool.label} — support can see your workspace now` : tool.key === "chat" && chatUnread > 0 ? `Chat — ${chatUnread} unread` : tool.label;
          const startsGroup = index > 0 && tools[index - 1].group !== tool.group;
          return (
            <div key={tool.key} className="flex flex-col items-center">
              {startsGroup && <div className="my-1.5 h-px w-6 bg-line" aria-hidden="true" />}
              <button
                type="button"
                title={label}
                aria-label={label}
                aria-pressed={isOpen}
                onClick={() => choose(tool.key)}
                className={`relative grid h-9 w-9 place-items-center rounded-base transition-colors ${
                  isOpen ? "bg-brand-subtle text-brand" : "text-muted hover:bg-surface-sunken hover:text-text"
                }`}
              >
                <Icon className="h-[18px] w-[18px]" />
                {news && news.company > 0 && <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-danger ring-2 ring-surface" aria-hidden="true" />}
                {news && news.deskzo > 0 && <span className="absolute bottom-1.5 right-1.5 h-2 w-2 rounded-full bg-brand ring-2 ring-surface" aria-hidden="true" />}
                {supportIn && <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-warning ring-2 ring-surface" aria-hidden="true" />}
                {tool.key === "chat" && chatUnread > 0 && (
                  <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-medium text-white" aria-hidden="true">
                    {chatUnread > 99 ? "99+" : chatUnread}
                  </span>
                )}
              </button>
            </div>
          );
        })}
        {/* Not a panel: the copilot has its own drawer, opened from the header. This is a second way
            in, next to Help, where somebody who is stuck is already looking. */}
        {copilot && (
          <button
            type="button"
            title="Ask the AI copilot"
            aria-label="Ask the AI copilot"
            onClick={() => window.dispatchEvent(new Event(COPILOT_OPEN_EVENT))}
            className="grid h-9 w-9 place-items-center rounded-base text-muted transition-colors hover:bg-surface-sunken hover:text-brand"
          >
            <Sparkles className="h-[18px] w-[18px]" />
          </button>
        )}
        {/* Contact Support: not a panel either — the dialog is the layout's
            (src/components/support/support-launcher.tsx). In the brand's colour, because it is the way
            out when nothing else here helped. Below xl, where this rail is hidden, the sidebar offers it. */}
        {support && (
          <button
            type="button"
            title="Contact support"
            aria-label="Contact support"
            aria-haspopup="dialog"
            onClick={openSupport}
            className="grid h-9 w-9 place-items-center rounded-base text-brand transition-colors hover:bg-brand-subtle"
          >
            <Headset className="h-[18px] w-[18px]" />
          </button>
        )}
        </div>
      </nav>
    </div>
  );
}

/** "What's new — 2 new from Deskzo, 1 new from your company": each source's count, named, in the button's label and tooltip. */
function withNews(label: string, news: { deskzo: number; company: number }): string {
  const parts = [news.deskzo > 0 ? `${news.deskzo} new from Deskzo` : null, news.company > 0 ? `${news.company} new from your company` : null].filter(Boolean);
  return parts.length ? `${label} — ${parts.join(", ")}` : label;
}

function subscribe(onChange: () => void) {
  // Both events: `storage` for the same tool opened in another tab, and our own for this one —
  // `storage` does not fire in the tab that made the change.
  window.addEventListener("storage", onChange);
  window.addEventListener(SIDE_RAIL_STORAGE_KEY, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(SIDE_RAIL_STORAGE_KEY, onChange);
  };
}

function getSnapshot(): SideRailTool | null {
  try {
    return parseTool(window.localStorage.getItem(SIDE_RAIL_STORAGE_KEY));
  } catch {
    return null;
  }
}

/** Always closed on the server. There is no reader there whose preference could be known. */
function getServerSnapshot(): SideRailTool | null {
  return null;
}
