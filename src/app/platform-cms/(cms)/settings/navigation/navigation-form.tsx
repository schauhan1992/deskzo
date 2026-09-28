"use client";

import { useId, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Columns3, Plus, X } from "lucide-react";
import { Banner } from "@/components/console/kit/banner";
import { Panel } from "@/components/console/kit/panel";
import { StatusPill } from "@/components/console/kit/status";
import { LINK_HINT, TextAreaField, TextField, hrefProblem, isMailto } from "@/components/cms/common/fields";
import { LinkListEditor, keyLinks, moveItem, newRowKey, unkeyLinks, type KeyedLink } from "@/components/cms/common/link-list-editor";
import type { SiteLink, SiteSettings } from "@/components/site/blocks/types";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import type { SettingsDetail } from "@/lib/cms/types";
import { cn } from "@/lib/utils";
import { PublishStatus, SaveBar } from "../settings-publishing";
import { useSettingsDraft } from "../use-settings-draft";

/**
 * Settings › Navigation: the header's menu and its two buttons (Sign in, and the sign-up button in
 * both of its forms — the site shows one or the other by whether sign-up is open), and the footer's
 * columns of links and its note. A preview beside the form draws the header and footer from what is
 * typed, before anything is saved. Editors and admins edit; everybody else reads.
 */

type Column = { key: string; title: string; links: KeyedLink[] };

type NavForm = {
  nav: KeyedLink[];
  signin: SiteLink;
  signupOpen: SiteLink;
  signupInvite: SiteLink;
  columns: Column[];
  note: string;
};

const MAX_COLUMNS = 5;

function toForm(s: SiteSettings): NavForm {
  return {
    nav: keyLinks(s.nav ?? [], "nav"),
    signin: { label: s.signinLink?.label ?? "", href: s.signinLink?.href ?? "" },
    signupOpen: { label: s.signupCta?.open?.label ?? "", href: s.signupCta?.open?.href ?? "" },
    signupInvite: { label: s.signupCta?.inviteOnly?.label ?? "", href: s.signupCta?.inviteOnly?.href ?? "" },
    columns: (s.footer?.columns ?? []).map((c, i) => ({ key: `col-${i}`, title: c.title ?? "", links: keyLinks(c.links ?? [], `col-${i}`) })),
    note: s.footer?.note ?? "",
  };
}

function toPartial(f: NavForm): Partial<SiteSettings> {
  return {
    nav: unkeyLinks(f.nav),
    signinLink: f.signin,
    signupCta: { open: f.signupOpen, inviteOnly: f.signupInvite },
    footer: { columns: f.columns.map((c) => ({ title: c.title, links: unkeyLinks(c.links) })), ...(f.note.trim() ? { note: f.note } : {}) },
  };
}

export function NavigationForm({
  detail,
  defaults,
  canEdit,
  signupOpen,
  trialDays,
  year,
  siteHost,
}: {
  detail: SettingsDetail;
  defaults: SiteSettings;
  canEdit: boolean;
  /** Whether sign-up is open right now — which of the two buttons the site shows. */
  signupOpen: boolean;
  /** The platform's trial length, for {trialDays} in the preview. */
  trialDays: number;
  /** This year in India, for the preview's footer line. */
  year: number;
  siteHost: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const draft = useSettingsDraft({ detail, defaults, toForm, toPartial, rootRef });
  const { form, setForm, issues } = draft;
  const readOnly = !canEdit;
  const set = <K extends keyof NavForm>(key: K, value: NavForm[K]) => setForm((f) => ({ ...f, [key]: value }));

  return (
    <div ref={rootRef} className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,28rem)]">
      <div className="min-w-0 space-y-6">
        <PublishStatus draft={draft} canEdit={canEdit} />
        {readOnly && (
          <Banner tone="info" title="You can read the site's navigation">
            Editors and admins change and publish it.
          </Banner>
        )}

        <Panel title="Header menu" description="The links across the top of every page, left to right. Keep it short — four or five reads best.">
          <LinkListEditor
            legend="Menu links"
            links={form.nav}
            onChange={(v) => set("nav", v)}
            max={8}
            basePath="nav"
            issues={issues}
            readOnly={readOnly}
            emptyText="No links — the header shows only the name and the two buttons."
          />
        </Panel>

        <Panel title="Header buttons" description="At the right of the header. The sign-up button has two forms; the site shows the one that fits whether sign-up is open.">
          <div className="space-y-5">
            <LinkPair legend="Sign in" value={form.signin} onChange={(v) => set("signin", v)} basePath="signinLink" issues={issues} readOnly={readOnly} />
            <LinkPair
              legend="While sign-up is open"
              badge={signupOpen ? "Showing now" : undefined}
              value={form.signupOpen}
              onChange={(v) => set("signupOpen", v)}
              basePath="signupCta.open"
              issues={issues}
              readOnly={readOnly}
            />
            <LinkPair
              legend="While sign-up is by invitation"
              badge={signupOpen ? undefined : "Showing now"}
              value={form.signupInvite}
              onChange={(v) => set("signupInvite", v)}
              basePath="signupCta.inviteOnly"
              issues={issues}
              readOnly={readOnly}
            />
          </div>
        </Panel>

        <Panel title="Footer" description="Columns of links at the bottom of every page, and a line under the name.">
          <div className="space-y-5">
            <ColumnsEditor columns={form.columns} onChange={(v) => set("columns", v)} issues={issues} readOnly={readOnly} />
            <TextAreaField
              label="Footer note"
              value={form.note}
              onChange={(v) => set("note", v)}
              max={300}
              rows={2}
              readOnly={readOnly}
              error={issues["footer.note"]}
              hint="Under the name in the footer. {tagline} writes the tagline."
            />
          </div>
        </Panel>

        {canEdit && <SaveBar draft={draft} />}
      </div>

      <aside aria-label="Preview" className="min-w-0">
        <div className="space-y-3 xl:sticky xl:top-20">
          <NavPreview form={form} settings={draft.saved.draft} signupOpen={signupOpen} trialDays={trialDays} year={year} siteHost={siteHost} />
        </div>
      </aside>
    </div>
  );
}

/** A single link — a label and an address — with its own heading. */
function LinkPair({
  legend,
  badge,
  value,
  onChange,
  basePath,
  issues,
  readOnly,
}: {
  legend: string;
  badge?: string;
  value: SiteLink;
  onChange: (next: SiteLink) => void;
  basePath: string;
  issues: Record<string, string>;
  readOnly: boolean;
}) {
  const hrefError = issues[`${basePath}.href`] ?? hrefProblem(value.href);
  return (
    <fieldset className="min-w-0">
      <legend className="mb-2 flex items-center gap-2 text-sm font-medium text-text">
        {legend}
        {badge && <StatusPill tone="success">{badge}</StatusPill>}
      </legend>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <TextField label={`${legend}: label`} value={value.label} onChange={(v) => onChange({ ...value, label: v })} max={80} required readOnly={readOnly} error={issues[`${basePath}.label`]} />
        <TextField
          label={`${legend}: address`}
          value={value.href}
          onChange={(v) => onChange({ ...value, href: v })}
          required
          readOnly={readOnly}
          mono
          inputMode="url"
          error={hrefError}
          hint={!hrefError && isMailto(value.href) ? "The site shows mailto: addresses as plain text, not as a button." : LINK_HINT}
        />
      </div>
    </fieldset>
  );
}

function ColumnsEditor({ columns, onChange, issues, readOnly }: { columns: Column[]; onChange: (next: Column[]) => void; issues: Record<string, string>; readOnly: boolean }) {
  const id = useId();
  const focusColumn = useRef<string | null>(null);
  const update = (key: string, change: Partial<Column>) => onChange(columns.map((c) => (c.key === key ? { ...c, ...change } : c)));
  const focusIfPending = (key: string) => (el: HTMLInputElement | null) => {
    if (el && focusColumn.current === key) {
      focusColumn.current = null;
      el.focus();
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 id={`${id}-heading`} className="text-sm font-medium text-text">
          Columns
          <span className="ml-2 text-xs font-normal text-subtle tabular-nums">
            {columns.length} of {MAX_COLUMNS}
          </span>
        </h3>
      </div>
      {issues["footer.columns"] && <p className="text-xs text-danger">{issues["footer.columns"]}</p>}
      {columns.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line px-4 py-3 text-xs text-muted">No columns — the footer shows only the name, the note and the sales email.</p>
      ) : (
        <ol aria-labelledby={`${id}-heading`} className="grid gap-3 2xl:grid-cols-2">
          {columns.map((column, i) => {
            const name = column.title.trim() || `column ${i + 1}`;
            return (
              <li key={column.key} className="rounded-lg border border-line p-3">
                <div className="mb-3 flex items-start gap-2">
                  <Columns3 aria-hidden="true" className="mt-2.5 h-4 w-4 shrink-0 text-subtle" />
                  <TextField
                    label={`Title of footer column ${i + 1}`}
                    value={column.title}
                    onChange={(v) => update(column.key, { title: v })}
                    max={80}
                    required
                    readOnly={readOnly}
                    error={issues[`footer.columns[${i}].title`]}
                    inputRef={focusIfPending(column.key)}
                    className="flex-1"
                  />
                  {!readOnly && (
                    <div className="mt-6 flex shrink-0 items-center">
                      <IconButton icon={ArrowUp} label={`Move ${name} left`} onClick={() => onChange(moveItem(columns, i, -1))} disabled={i === 0} />
                      <IconButton icon={ArrowDown} label={`Move ${name} right`} onClick={() => onChange(moveItem(columns, i, 1))} disabled={i === columns.length - 1} />
                      <IconButton icon={X} label={`Remove ${name} and its links`} tone="danger" onClick={() => onChange(columns.filter((c) => c.key !== column.key))} />
                    </div>
                  )}
                </div>
                <LinkListEditor
                  legend={`Links in ${name}`}
                  links={column.links}
                  onChange={(v) => update(column.key, { links: v })}
                  max={10}
                  basePath={`footer.columns[${i}].links`}
                  issues={issues}
                  readOnly={readOnly}
                  emptyText="No links in this column yet."
                />
              </li>
            );
          })}
        </ol>
      )}
      {!readOnly && (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={columns.length >= MAX_COLUMNS}
          onClick={() => {
            const key = newRowKey();
            focusColumn.current = key;
            onChange([...columns, { key, title: "", links: [] }]);
          }}
        >
          <Plus aria-hidden="true" className="h-4 w-4" />
          {columns.length >= MAX_COLUMNS ? `The footer takes ${MAX_COLUMNS} columns` : "Add a column"}
        </Button>
      )}
    </div>
  );
}

/** The editor's tokens, filled from the settings for the preview. */
function fill(text: string, s: SiteSettings, trialDays: number): string {
  return text
    .replace(/\{siteName\}/g, s.siteName)
    .replace(/\{tagline\}/g, s.tagline)
    .replace(/\{displayDomain\}/g, s.displayDomain)
    .replace(/\{salesEmail\}/g, s.salesEmail)
    .replace(/\{trialDays\}/g, String(trialDays));
}

/**
 * The header and footer as the site will lay them out, drawn from the form — not the site's own
 * components, whose links would lead off into this host. A wireframe in the site's own colours; the
 * sign-up button can be shown in either form.
 */
function NavPreview({
  form,
  settings,
  signupOpen,
  trialDays,
  year,
  siteHost,
}: {
  form: NavForm;
  settings: SiteSettings;
  signupOpen: boolean;
  trialDays: number;
  year: number;
  siteHost: string;
}) {
  const [asOpen, setAsOpen] = useState(signupOpen);
  const cta = asOpen ? form.signupOpen : form.signupInvite;
  const t = (text: string) => fill(text, settings, trialDays);
  const nameId = useId();

  return (
    <section aria-labelledby={nameId} className="overflow-hidden rounded-xl border border-line bg-surface shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <h2 id={nameId} className="text-sm font-semibold text-text">
          Preview
        </h2>
        <div role="group" aria-label="Show the sign-up button as" className="flex gap-0.5 rounded-base border border-line bg-surface-sunken p-0.5">
          {[
            { open: true, label: "Sign-up open" },
            { open: false, label: "Invitation only" },
          ].map((option) => (
            <button
              key={option.label}
              type="button"
              aria-pressed={asOpen === option.open}
              onClick={() => setAsOpen(option.open)}
              className={cn("h-6 rounded-[6px] px-2 text-[11px] font-medium transition-colors", asOpen === option.open ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text")}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div aria-hidden="true" className="bg-bg">
        {/* The browser's own bar, so the preview reads as a page and not as more of the form. */}
        <div className="flex items-center gap-2 border-b border-line bg-surface-sunken px-3 py-1.5">
          <span className="flex gap-1">
            <span className="h-2 w-2 rounded-full bg-line-strong" />
            <span className="h-2 w-2 rounded-full bg-line-strong" />
            <span className="h-2 w-2 rounded-full bg-line-strong" />
          </span>
          <span className="min-w-0 flex-1 truncate rounded bg-surface px-2 py-0.5 text-center font-mono text-[10px] text-subtle">{siteHost}</span>
        </div>

        <div className="flex items-center gap-3 border-b border-line px-4 py-3">
          <span className="flex shrink-0 items-center gap-1.5">
            <span className="grid h-5 w-5 place-items-center rounded-md bg-brand text-[9px] font-bold text-brand-contrast">{(settings.siteName.trim()[0] ?? "W").toUpperCase()}</span>
            <span className="max-w-24 truncate text-xs font-semibold text-text">{settings.siteName}</span>
          </span>
          <span className="flex min-w-0 flex-1 flex-wrap gap-x-2.5 gap-y-1 overflow-hidden">
            {form.nav.length === 0 ? (
              <span className="text-[11px] text-subtle italic">no menu links</span>
            ) : (
              form.nav.map((link) => (
                <span key={link.key} className="truncate text-[11px] text-muted">
                  {t(link.label) || "…"}
                </span>
              ))
            )}
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            <span className="text-[11px] font-medium text-text">{t(form.signin.label) || "…"}</span>
            <span className="rounded-md bg-brand px-2 py-1 text-[11px] font-medium text-brand-contrast">{t(cta.label) || "…"}</span>
          </span>
        </div>

        <div className="space-y-2 px-4 py-6">
          <div className="h-3 w-2/3 rounded bg-surface-sunken" />
          <div className="h-2 w-5/6 rounded bg-surface-sunken" />
          <div className="h-2 w-1/2 rounded bg-surface-sunken" />
        </div>

        <div className="border-t border-line bg-surface-sunken px-4 py-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="min-w-0 sm:col-span-1">
              <p className="truncate text-xs font-semibold text-text">{settings.siteName}</p>
              {form.note.trim() && <p className="mt-1 line-clamp-3 text-[11px] text-muted">{t(form.note)}</p>}
              {settings.salesEmail.trim() && <p className="mt-1 truncate text-[11px] font-medium text-text">{settings.salesEmail}</p>}
            </div>
            <div className="grid min-w-0 grid-cols-2 gap-3 sm:col-span-2 sm:grid-cols-3">
              {form.columns.map((column) => (
                <div key={column.key} className="min-w-0">
                  <p className="truncate text-[11px] font-semibold text-text">{t(column.title) || "…"}</p>
                  <ul className="mt-1 space-y-0.5">
                    {column.links.map((link) => (
                      <li key={link.key} className="truncate text-[11px] text-muted">
                        {t(link.label) || "…"}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
          <p className="mt-4 border-t border-line pt-2 text-[10px] text-subtle">
            © {year} {settings.siteName}
          </p>
        </div>
      </div>
      <p className="border-t border-line px-4 py-2 text-[11px] text-muted">From what&apos;s typed here — the site changes only when the settings are published.</p>
    </section>
  );
}
