"use client";

import { useRef, useState } from "react";
import { Menu, X } from "lucide-react";
import type { SiteLink } from "@/components/site/blocks/types";
import { ButtonLink, Container, SiteAnchor } from "@/components/site/ui";
import { SiteLogo } from "@/components/site/logo";

/**
 * The public site's header: the name, the main links, "Sign in" and the call to action — which the
 * layout has already worked out ("Start free trial" or "Request an invitation"). Below `md` the links
 * fold into a menu: a button that says whether it is open, closed again by Escape or by following a
 * link.
 */
export function SiteHeader({ siteName, nav, signin, cta }: { siteName: string; nav: SiteLink[]; signin: SiteLink; cta: SiteLink }) {
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  return (
    <header
      className="sticky top-0 z-40 border-b border-line bg-bg/85 backdrop-blur-md"
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          setOpen(false);
          toggle.current?.focus();
        }
      }}
    >
      <Container className="flex h-16 items-center gap-4">
        <SiteLogo name={siteName} />
        <nav aria-label="Main" className="ml-4 hidden items-center gap-1 md:flex">
          {nav.map((link) => (
            <SiteAnchor key={`${link.href}-${link.label}`} href={link.href} className="rounded-md px-3 py-2 text-sm font-medium text-muted transition-colors hover:text-text">
              {link.label}
            </SiteAnchor>
          ))}
        </nav>
        <div className="ml-auto hidden items-center gap-2 md:flex">
          <ButtonLink href={signin.href} label={signin.label} tone="ghost" />
          <ButtonLink href={cta.href} label={cta.label} />
        </div>
        <button
          ref={toggle}
          type="button"
          className="ml-auto grid h-10 w-10 place-items-center rounded-base text-muted transition-colors hover:bg-surface-sunken hover:text-text md:hidden"
          aria-expanded={open}
          aria-controls="site-menu"
          aria-label={open ? "Close menu" : "Open menu"}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? <X aria-hidden="true" className="h-5 w-5" /> : <Menu aria-hidden="true" className="h-5 w-5" />}
        </button>
      </Container>
      <div
        id="site-menu"
        hidden={!open}
        className="border-t border-line bg-bg md:hidden"
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("a")) setOpen(false);
        }}
      >
        <Container className="py-3">
          <nav aria-label="Main">
            <ul>
              {nav.map((link) => (
                <li key={`${link.href}-${link.label}`}>
                  <SiteAnchor href={link.href} className="block rounded-md px-2 py-3 text-base font-medium text-text hover:bg-surface-sunken">
                    {link.label}
                  </SiteAnchor>
                </li>
              ))}
            </ul>
          </nav>
          <div className="mt-3 grid gap-2 border-t border-line pb-2 pt-4">
            <ButtonLink href={signin.href} label={signin.label} tone="secondary" size="lg" />
            <ButtonLink href={cta.href} label={cta.label} size="lg" />
          </div>
        </Container>
      </div>
    </header>
  );
}
