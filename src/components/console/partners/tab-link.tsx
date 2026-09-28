"use client";

import type { MouseEvent, ReactNode } from "react";
import { PARTNER_TABS_ID } from "./format";

/**
 * A link to one of the partner 360's tabs — from a banner, a KPI, "See the customers". It switches in
 * place through the tab itself (`pt-tab-<key>`), so every switch goes one way: instant, with the
 * address following. Without the tab on the page (or with a modifier key held) it is an ordinary link
 * to the same `?tab=` address.
 */
export function PartnerTabLink({ tab, href, className, children }: { tab: string; href: string; className?: string; children: ReactNode }) {
  function onClick(e: MouseEvent<HTMLAnchorElement>) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const target = document.getElementById(`${PARTNER_TABS_ID}-tab-${tab}`);
    if (!target) return;
    e.preventDefault();
    target.click();
    target.focus({ preventScroll: true });
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({ block: "nearest", behavior: still ? "auto" : "smooth" });
  }
  return (
    <a href={href} onClick={onClick} className={className}>
      {children}
    </a>
  );
}
