"use client";

import { useId, useRef } from "react";
import { ArrowDown, ArrowUp, AtSign, Globe, Plus, Search, Share2, SignpostBig, X } from "lucide-react";
import { Banner } from "@/components/console/kit/banner";
import { Panel } from "@/components/console/kit/panel";
import { StatusPill } from "@/components/console/kit/status";
import { TextAreaField, TextField, hrefProblem } from "@/components/cms/common/fields";
import { LinkListEditor, keyLinks, moveItem, newRowKey, unkeyLinks, type KeyedLink } from "@/components/cms/common/link-list-editor";
import { MediaSelect } from "@/components/cms/common/media-select";
import type { SiteSettings, SocialNetwork } from "@/components/site/blocks/types";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Label, Select } from "@/components/ui/input";
import type { MediaRow, SettingsDetail } from "@/lib/cms/types";
import { cn } from "@/lib/utils";
import { PublishStatus, SaveBar } from "./settings-publishing";
import { useSettingsDraft } from "./use-settings-draft";

/**
 * Settings › General: who the site says it is (name, tagline, the domain it writes in text), the
 * sales address it shows, its social links, what search engines and link previews get by default,
 * and the page for an address it does not have. Editors and admins edit; everybody else reads the
 * same form with nothing to press.
 *
 * The placeholders stay until somebody decides — "Your tagline goes here", "yourdomain.com",
 * "sales@yourdomain.com" — and each is marked as a placeholder while it is one.
 */

type KeyedSocial = { key: string; network: SocialNetwork; href: string; label: string };

type GeneralForm = {
  siteName: string;
  tagline: string;
  displayDomain: string;
  salesEmail: string;
  social: KeyedSocial[];
  seo: { titleTemplate: string; defaultTitle: string; description: string; ogImage: string };
  notFound: { heading: string; body: string; links: KeyedLink[] };
};

const NETWORKS: { value: SocialNetwork; label: string }[] = [
  { value: "linkedin", label: "LinkedIn" },
  { value: "x", label: "X" },
  { value: "youtube", label: "YouTube" },
  { value: "facebook", label: "Facebook" },
  { value: "instagram", label: "Instagram" },
  { value: "github", label: "GitHub" },
  { value: "other", label: "Other" },
];

/** Module-level, so the draft hook's callbacks never change identity. */
function toForm(s: SiteSettings): GeneralForm {
  return {
    siteName: s.siteName ?? "",
    tagline: s.tagline ?? "",
    displayDomain: s.displayDomain ?? "",
    salesEmail: s.salesEmail ?? "",
    social: (s.social ?? []).map((x, i) => ({ key: `social-${i}`, network: x.network, href: x.href ?? "", label: x.label ?? "" })),
    seo: { titleTemplate: s.seo?.titleTemplate ?? "", defaultTitle: s.seo?.defaultTitle ?? "", description: s.seo?.description ?? "", ogImage: s.seo?.ogImage ?? "" },
    notFound: { heading: s.notFound?.heading ?? "", body: s.notFound?.body ?? "", links: keyLinks(s.notFound?.links ?? [], "nf") },
  };
}

function toPartial(f: GeneralForm): Partial<SiteSettings> {
  return {
    siteName: f.siteName,
    tagline: f.tagline,
    displayDomain: f.displayDomain,
    salesEmail: f.salesEmail,
    social: f.social.map(({ network, href, label }) => ({ network, href, ...(label.trim() ? { label } : {}) })),
    seo: { titleTemplate: f.seo.titleTemplate, defaultTitle: f.seo.defaultTitle, description: f.seo.description, ...(f.seo.ogImage ? { ogImage: f.seo.ogImage } : {}) },
    notFound: { heading: f.notFound.heading, body: f.notFound.body, links: unkeyLinks(f.notFound.links) },
  };
}

/** Text as the site will show it — the tokens editors may use, filled from this form. */
function filled(text: string, f: GeneralForm): string {
  return text
    .replace(/\{siteName\}/g, f.siteName.trim() || "…")
    .replace(/\{tagline\}/g, f.tagline.trim())
    .replace(/\{displayDomain\}/g, f.displayDomain.trim())
    .replace(/\{salesEmail\}/g, f.salesEmail.trim());
}

function Placeholder({ is }: { is: boolean }) {
  if (!is) return null;
  return (
    <span className="inline-flex items-center gap-1.5">
      <StatusPill tone="warning">Placeholder</StatusPill>
      <span>Still the placeholder — replace it once it&apos;s decided.</span>
    </span>
  );
}

const SECTIONS = [
  { id: "identity", label: "Identity", icon: Globe },
  { id: "contact", label: "Contact email", icon: AtSign },
  { id: "social", label: "Social links", icon: Share2 },
  { id: "seo", label: "Search & sharing", icon: Search },
  { id: "not-found", label: "Page not found", icon: SignpostBig },
] as const;

export function GeneralSettingsForm({
  detail,
  defaults,
  canEdit,
  ogMedia,
}: {
  detail: SettingsDetail;
  defaults: SiteSettings;
  canEdit: boolean;
  ogMedia: MediaRow | null;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const draft = useSettingsDraft({ detail, defaults, toForm, toPartial, rootRef });
  const { form, setForm, issues } = draft;
  const readOnly = !canEdit;
  const set = <K extends keyof GeneralForm>(key: K, value: GeneralForm[K]) => setForm((f) => ({ ...f, [key]: value }));
  const setSeo = (change: Partial<GeneralForm["seo"]>) => setForm((f) => ({ ...f, seo: { ...f.seo, ...change } }));
  const setNotFound = (change: Partial<GeneralForm["notFound"]>) => setForm((f) => ({ ...f, notFound: { ...f.notFound, ...change } }));

  const exampleTitle = filled(form.seo.titleTemplate.includes("%s") ? form.seo.titleTemplate.replace("%s", "Pricing") : form.seo.titleTemplate, form);
  const homeTitle = filled(form.seo.defaultTitle, form);

  return (
    <div ref={rootRef} className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_14rem]">
      <div className="min-w-0 space-y-6">
        <PublishStatus draft={draft} canEdit={canEdit} />
        {readOnly && (
          <Banner tone="info" title="You can read the site's settings">
            Editors and admins change and publish them.
          </Banner>
        )}

        <Panel id="identity" title="Identity" description="Who the site says it is. Text anywhere on the site can use {siteName}, {tagline} and {displayDomain}.">
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Site name"
              value={form.siteName}
              onChange={(v) => set("siteName", v)}
              max={80}
              required
              readOnly={readOnly}
              error={issues.siteName}
              hint="In the header, the footer and every browser tab."
            />
            <TextField
              label="Display domain"
              value={form.displayDomain}
              onChange={(v) => set("displayDomain", v)}
              max={100}
              readOnly={readOnly}
              mono
              error={issues.displayDomain}
              hint={form.displayDomain.trim() === defaults.displayDomain ? <Placeholder is /> : "How the site writes its address in text. Links still go to the real domain."}
            />
            <TextField
              label="Tagline"
              value={form.tagline}
              onChange={(v) => set("tagline", v)}
              max={160}
              readOnly={readOnly}
              error={issues.tagline}
              className="sm:col-span-2"
              hint={form.tagline.trim() === defaults.tagline ? <Placeholder is /> : "One line under the name — in the footer, and wherever {tagline} is written."}
            />
          </div>
        </Panel>

        <Panel id="contact" title="Contact email" description="The sales address the site shows, wherever {salesEmail} is written and in the footer.">
          <TextField
            label="Sales email"
            type="email"
            inputMode="email"
            value={form.salesEmail}
            onChange={(v) => set("salesEmail", v)}
            max={254}
            readOnly={readOnly}
            mono
            error={issues.salesEmail}
            hint={
              form.salesEmail.trim() === defaults.salesEmail ? (
                <Placeholder is />
              ) : (
                "Shown to visitors. Contact-form requests are emailed to the address the platform team configured, not to this one — and every one lands in Leads."
              )
            }
          />
        </Panel>

        <Panel id="social" title="Social links" description="Along the bottom of every page. Full https:// addresses only.">
          <SocialEditor links={form.social} onChange={(v) => set("social", v)} issues={issues} readOnly={readOnly} />
        </Panel>

        <Panel id="seo" title="Search & sharing" description="What search engines and link previews show when a page doesn't say otherwise.">
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label="Title template"
                value={form.seo.titleTemplate}
                onChange={(v) => setSeo({ titleTemplate: v })}
                max={120}
                required
                readOnly={readOnly}
                mono
                error={issues["seo.titleTemplate"] ?? (form.seo.titleTemplate && !form.seo.titleTemplate.includes("%s") ? "Put %s where each page's title goes." : null)}
                hint={
                  <>
                    A page called Pricing becomes <span className="font-medium text-text">{exampleTitle || "…"}</span>
                  </>
                }
              />
              <TextField
                label="Home page title"
                value={form.seo.defaultTitle}
                onChange={(v) => setSeo({ defaultTitle: v })}
                max={120}
                required
                readOnly={readOnly}
                error={issues["seo.defaultTitle"]}
                hint="The browser tab and search result for the home page, and any page without a title."
              />
            </div>
            <TextAreaField
              label="Default description"
              value={form.seo.description}
              onChange={(v) => setSeo({ description: v })}
              max={300}
              readOnly={readOnly}
              error={issues["seo.description"]}
              hint="One or two sentences for search results. Around 150 characters reads best."
            />
            <SearchPreview title={homeTitle} url={form.displayDomain.trim() || "yourdomain.com"} description={filled(form.seo.description, form)} />
            <MediaSelect
              label="Sharing image"
              description="Shown when a link to the site is shared, unless a page has its own. 1200 × 630 works everywhere."
              value={form.seo.ogImage}
              onChange={(v) => setSeo({ ogImage: v })}
              initial={ogMedia}
              error={issues["seo.ogImage"]}
              readOnly={readOnly}
            />
          </div>
        </Panel>

        <Panel id="not-found" title="Page not found" description="What a visitor sees at an address the site doesn't have.">
          <div className="space-y-4">
            <TextField
              label="Heading"
              value={form.notFound.heading}
              onChange={(v) => setNotFound({ heading: v })}
              max={200}
              required
              readOnly={readOnly}
              error={issues["notFound.heading"]}
            />
            <TextAreaField
              label="Text"
              value={form.notFound.body}
              onChange={(v) => setNotFound({ body: v })}
              max={1000}
              required
              readOnly={readOnly}
              error={issues["notFound.body"]}
            />
            <LinkListEditor
              legend="Suggested links"
              description="Places to go instead — usually home, pricing and sign in."
              links={form.notFound.links}
              onChange={(v) => setNotFound({ links: v })}
              max={6}
              basePath="notFound.links"
              issues={issues}
              readOnly={readOnly}
              emptyText="No suggestions — the page shows only its heading and text."
              labelPlaceholder="Home"
              hrefPlaceholder="/"
            />
          </div>
        </Panel>

        {canEdit && <SaveBar draft={draft} />}
      </div>

      <nav aria-label="Settings sections" className="hidden xl:block">
        <div className="sticky top-20 space-y-1">
          <p className="px-2 pb-1 text-[11px] font-semibold tracking-[0.08em] text-subtle uppercase">On this page</p>
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <a key={id} href={`#${id}`} className="flex items-center gap-2 rounded-base px-2 py-1.5 text-[13px] text-muted hover:bg-surface-sunken hover:text-text">
              <Icon aria-hidden="true" className="h-3.5 w-3.5 text-subtle" />
              {label}
            </a>
          ))}
        </div>
      </nav>
    </div>
  );
}

/** Roughly how a search engine lists the home page — the title, the address, the description. */
function SearchPreview({ title, url, description }: { title: string; url: string; description: string }) {
  return (
    <figure className="rounded-lg border border-line bg-surface-sunken px-4 py-3">
      <figcaption className="mb-2 text-[11px] font-semibold tracking-[0.08em] text-subtle uppercase">In a search result</figcaption>
      <p translate="no" className="truncate font-mono text-xs text-muted">
        {url}
      </p>
      <p className="mt-0.5 truncate text-base text-info">{title || "The home page title"}</p>
      <p className={cn("mt-0.5 line-clamp-2 text-[13px]", description ? "text-muted" : "text-subtle italic")}>{description || "No description — search engines will pick text from the page."}</p>
    </figure>
  );
}

function SocialEditor({
  links,
  onChange,
  issues,
  readOnly,
}: {
  links: KeyedSocial[];
  onChange: (next: KeyedSocial[]) => void;
  issues: Record<string, string>;
  readOnly: boolean;
}) {
  const id = useId();
  const focusRow = useRef<string | null>(null);
  const max = 10;
  const update = (key: string, change: Partial<KeyedSocial>) => onChange(links.map((l) => (l.key === key ? { ...l, ...change } : l)));
  const focusIfPending = (key: string) => (el: HTMLSelectElement | null) => {
    if (el && focusRow.current === key) {
      focusRow.current = null;
      el.focus();
    }
  };

  return (
    <div className="space-y-3">
      {issues.social && <p className="text-xs text-danger">{issues.social}</p>}
      {links.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line px-4 py-3 text-xs text-muted">No social links — the footer leaves the space empty.</p>
      ) : (
        <ol className="space-y-2">
          {links.map((link, i) => {
            const name = NETWORKS.find((n) => n.value === link.network)?.label ?? link.network;
            const hrefError = issues[`social[${i}].href`] ?? hrefProblem(link.href, true);
            const networkId = `${id}-${link.key}-network`;
            return (
              <li key={link.key} className="rounded-lg border border-line bg-surface-sunken/50 p-3">
                <div className="flex items-start gap-2">
                  <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-[9rem_minmax(0,1fr)_minmax(0,12rem)]">
                    <div className="space-y-1.5">
                      <Label htmlFor={networkId} className="sr-only">
                        Network for social link {i + 1}
                      </Label>
                      <Select
                        ref={focusIfPending(link.key)}
                        id={networkId}
                        value={link.network}
                        onChange={(e) => update(link.key, { network: e.target.value as SocialNetwork })}
                        disabled={readOnly}
                      >
                        {NETWORKS.map((n) => (
                          <option key={n.value} value={n.value}>
                            {n.label}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <TextField
                      label={`Address for the ${name} link`}
                      srOnlyLabel
                      value={link.href}
                      onChange={(v) => update(link.key, { href: v })}
                      placeholder="https://www.linkedin.com/company/…"
                      error={hrefError}
                      readOnly={readOnly}
                      mono
                      inputMode="url"
                    />
                    <TextField
                      label={`Label for the ${name} link (optional)`}
                      srOnlyLabel
                      value={link.label}
                      onChange={(v) => update(link.key, { label: v })}
                      placeholder={`Label (default: ${name})`}
                      max={80}
                      error={issues[`social[${i}].label`]}
                      readOnly={readOnly}
                    />
                  </div>
                  {!readOnly && (
                    <div className="mt-1 flex shrink-0 items-center">
                      <IconButton icon={ArrowUp} label={`Move ${name} up`} onClick={() => onChange(moveItem(links, i, -1))} disabled={i === 0} />
                      <IconButton icon={ArrowDown} label={`Move ${name} down`} onClick={() => onChange(moveItem(links, i, 1))} disabled={i === links.length - 1} />
                      <IconButton icon={X} label={`Remove ${name}`} tone="danger" onClick={() => onChange(links.filter((l) => l.key !== link.key))} />
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {!readOnly && (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={links.length >= max}
            onClick={() => {
              const key = newRowKey();
              focusRow.current = key;
              const used = new Set(links.map((l) => l.network));
              const network = NETWORKS.find((n) => n.value !== "other" && !used.has(n.value))?.value ?? "other";
              onChange([...links, { key, network, href: "", label: "" }]);
            }}
          >
            <Plus aria-hidden="true" className="h-4 w-4" />
            Add a social link
          </Button>
          <span className="text-xs text-subtle">{links.length >= max ? `That's the most the footer takes (${max}).` : `${links.length} of ${max}`}</span>
        </div>
      )}
    </div>
  );
}
