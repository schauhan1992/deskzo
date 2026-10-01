"use client";

import { useId, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, Columns3, Link2, PanelTop, Plus, X } from "lucide-react";
import { Banner } from "@/components/console/kit/banner";
import { Panel } from "@/components/console/kit/panel";
import { StatusPill } from "@/components/console/kit/status";
import { LINK_HINT, TextAreaField, TextField, hrefProblem, isMailto } from "@/components/cms/common/fields";
import { LinkListEditor, keyLinks, moveItem, newRowKey, unkeyLinks, type KeyedLink } from "@/components/cms/common/link-list-editor";
import { NAV_LIMITS, type NavItem, type SiteLink, type SiteSettings } from "@/components/site/blocks/types";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import type { SettingsDetail } from "@/lib/cms/types";
import { cn } from "@/lib/utils";
import { PublishStatus, SaveBar } from "../settings-publishing";
import { useSettingsDraft } from "../use-settings-draft";

/**
 * Settings › Navigation: the header's items and its two buttons (Sign in, and the sign-up button in
 * both of its forms — the site shows one or the other by whether sign-up is open), and the footer's
 * columns of links and its note. A preview beside the form draws the header — any menu opened — and
 * the footer from what is typed, before anything is saved. Editors and admins edit; everybody else reads.
 *
 * A header item is a link, or a menu: columns, each a title and its links with a line on what each
 * page is, and optionally a link along the menu's foot. Limits and messages are the server's own
 * (src/lib/cms/validate.ts, through the settings draft): 8 items, 5 columns a menu, 10 links a
 * column, 80 characters a line; 6 footer columns.
 */

type Column = { key: string; title: string; links: KeyedLink[] };
type MenuEntry = { key: string; label: string; href: string; description: string };
type MenuColumn = { key: string; title: string; items: MenuEntry[] };
type NavRow = { key: string; kind: "link"; label: string; href: string } | { key: string; kind: "menu"; label: string; columns: MenuColumn[]; footer: SiteLink | null };

type NavForm = {
  nav: NavRow[];
  signin: SiteLink;
  signupOpen: SiteLink;
  signupInvite: SiteLink;
  columns: Column[];
  note: string;
};

const MAX_FOOTER_COLUMNS = NAV_LIMITS.footerColumns;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** The stored items as rows the form edits — half-written ones kept as they are, so a draft round-trips. */
function keyNav(nav: unknown): NavRow[] {
  return arr(nav).map((raw, i): NavRow => {
    const item = isObj(raw) ? raw : {};
    if (!Array.isArray(item.columns)) return { key: `nav-${i}`, kind: "link", label: str(item.label), href: str(item.href) };
    return {
      key: `nav-${i}`,
      kind: "menu",
      label: str(item.label),
      columns: item.columns.map((c, j) => {
        const col = isObj(c) ? c : {};
        return {
          key: `nav-${i}-${j}`,
          title: str(col.title),
          items: arr(col.items).map((e, k) => {
            const entry = isObj(e) ? e : {};
            return { key: `nav-${i}-${j}-${k}`, label: str(entry.label), href: str(entry.href), description: str(entry.description) };
          }),
        };
      }),
      footer: isObj(item.footer) ? { label: str(item.footer.label), href: str(item.footer.href) } : null,
    };
  });
}

function unkeyNav(rows: readonly NavRow[]): NavItem[] {
  return rows.map((row) =>
    row.kind === "link"
      ? { label: row.label, href: row.href }
      : {
          label: row.label,
          columns: row.columns.map((c) => ({ title: c.title, items: c.items.map((e) => ({ label: e.label, href: e.href, ...(e.description.trim() ? { description: e.description } : {}) })) })),
          ...(row.footer ? { footer: row.footer } : {}),
        },
  );
}

function toForm(s: SiteSettings): NavForm {
  return {
    nav: keyNav(s.nav),
    signin: { label: s.signinLink?.label ?? "", href: s.signinLink?.href ?? "" },
    signupOpen: { label: s.signupCta?.open?.label ?? "", href: s.signupCta?.open?.href ?? "" },
    signupInvite: { label: s.signupCta?.inviteOnly?.label ?? "", href: s.signupCta?.inviteOnly?.href ?? "" },
    columns: (s.footer?.columns ?? []).map((c, i) => ({ key: `col-${i}`, title: c.title ?? "", links: keyLinks(c.links ?? [], `col-${i}`) })),
    note: s.footer?.note ?? "",
  };
}

function toPartial(f: NavForm): Partial<SiteSettings> {
  return {
    nav: unkeyNav(f.nav),
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

        <Panel
          title="Header menu"
          description="The items across the top of every page, left to right: a link, or a menu that opens a panel of columns. Keep it short — five or six reads best."
        >
          <NavItemsEditor rows={form.nav} onChange={(v) => set("nav", v)} issues={issues} readOnly={readOnly} />
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

// ─── The header's items ──────────────────────────────────────────────────────────────────────────

/** Move up, move down, remove — buttons named for what they act on ("Move Product up"). */
function RowButtons({ name, index, count, onMove, onRemove, removeLabel }: { name: string; index: number; count: number; onMove: (by: -1 | 1) => void; onRemove: () => void; removeLabel?: string }) {
  return (
    <div className="flex shrink-0 items-center">
      <IconButton icon={ArrowUp} label={`Move ${name} up`} onClick={() => onMove(-1)} disabled={index === 0} />
      <IconButton icon={ArrowDown} label={`Move ${name} down`} onClick={() => onMove(1)} disabled={index === count - 1} />
      <IconButton icon={X} label={removeLabel ?? `Remove ${name}`} tone="danger" onClick={onRemove} />
    </div>
  );
}

/** Focus for a row just added: the ref of its first field asks for it once, when it is on screen. */
function useFocusNext() {
  const pending = useRef<string | null>(null);
  return {
    want: (key: string) => {
      pending.current = key;
    },
    ref: (key: string) => (el: HTMLInputElement | null) => {
      if (el && pending.current === key) {
        pending.current = null;
        el.focus();
      }
    },
  };
}

function NavItemsEditor({ rows, onChange, issues, readOnly }: { rows: NavRow[]; onChange: (next: NavRow[]) => void; issues: Record<string, string>; readOnly: boolean }) {
  const id = useId();
  const focus = useFocusNext();
  const full = rows.length >= NAV_LIMITS.items;
  const update = (key: string, next: NavRow) => onChange(rows.map((r) => (r.key === key ? next : r)));
  const add = (kind: NavRow["kind"]) => {
    if (full) return;
    const key = newRowKey();
    focus.want(key);
    onChange([
      ...rows,
      kind === "link" ? { key, kind, label: "", href: "" } : { key, kind, label: "", columns: [{ key: newRowKey(), title: "", items: [{ key: newRowKey(), label: "", href: "", description: "" }] }], footer: null },
    ]);
  };

  return (
    <div className="space-y-3">
      <h3 id={`${id}-heading`} className="text-sm font-medium text-text">
        Items
        <span className="ml-2 text-xs font-normal text-subtle tabular-nums">
          {rows.length} of {NAV_LIMITS.items}
        </span>
      </h3>
      {issues.nav && <p className="text-xs text-danger">{issues.nav}</p>}
      {rows.length === 0 ? (
        <div className="flex items-center gap-2.5 rounded-lg border border-dashed border-line px-4 py-3 text-xs text-muted">
          <Link2 aria-hidden="true" className="h-4 w-4 shrink-0 text-subtle" />
          No items — the header shows only the name and the two buttons.
        </div>
      ) : (
        <ol aria-labelledby={`${id}-heading`} className="space-y-3">
          {rows.map((row, i) => {
            const base = `nav[${i}]`;
            const name = row.label.trim() || `item ${i + 1}`;
            const controls = !readOnly && (
              <RowButtons name={name} index={i} count={rows.length} onMove={(by) => onChange(moveItem(rows, i, by))} onRemove={() => onChange(rows.filter((r) => r.key !== row.key))} removeLabel={`Remove ${name}${row.kind === "menu" ? " and its links" : ""}`} />
            );
            return (
              <li key={row.key} className="rounded-lg border border-line bg-surface-sunken/40 p-3">
                <div className="flex items-start gap-2">
                  <span className="mt-2 inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-surface px-2 text-[11px] font-semibold text-muted">
                    {row.kind === "menu" ? <PanelTop aria-hidden="true" className="h-3 w-3" /> : <Link2 aria-hidden="true" className="h-3 w-3" />}
                    {row.kind === "menu" ? "Menu" : "Link"}
                  </span>
                  {row.kind === "link" ? (
                    <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
                      <TextField
                        label={`Item ${i + 1}: label`}
                        srOnlyLabel
                        value={row.label}
                        onChange={(v) => update(row.key, { ...row, label: v })}
                        max={80}
                        placeholder="Pricing"
                        error={issues[`${base}.label`]}
                        readOnly={readOnly}
                        inputRef={focus.ref(row.key)}
                      />
                      <TextField
                        label={`Item ${i + 1}: address`}
                        srOnlyLabel
                        value={row.href}
                        onChange={(v) => update(row.key, { ...row, href: v })}
                        placeholder="/pricing"
                        error={issues[`${base}.href`] ?? hrefProblem(row.href)}
                        readOnly={readOnly}
                        mono
                        inputMode="url"
                      />
                    </div>
                  ) : (
                    <TextField
                      label={`Item ${i + 1}: menu label`}
                      srOnlyLabel
                      value={row.label}
                      onChange={(v) => update(row.key, { ...row, label: v })}
                      max={80}
                      placeholder="Product"
                      error={issues[`${base}.label`]}
                      readOnly={readOnly}
                      inputRef={focus.ref(row.key)}
                      className="flex-1"
                    />
                  )}
                  {controls && <div className="mt-1">{controls}</div>}
                </div>
                {row.kind === "menu" && <MenuEditor menu={row} onChange={(next) => update(row.key, next)} base={base} issues={issues} readOnly={readOnly} />}
              </li>
            );
          })}
        </ol>
      )}
      {!readOnly && (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={() => add("link")} disabled={full}>
            <Plus aria-hidden="true" className="h-4 w-4" />
            Add a link
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={() => add("menu")} disabled={full}>
            <Plus aria-hidden="true" className="h-4 w-4" />
            Add a menu
          </Button>
          <span className={cn("text-xs", full ? "text-warning" : "text-subtle")}>{full ? `The header takes ${NAV_LIMITS.items} items.` : LINK_HINT}</span>
        </div>
      )}
    </div>
  );
}

type MenuRow = Extract<NavRow, { kind: "menu" }>;

/** A menu's columns — a title and its links, each with a line on what it is — and the link along its foot. */
function MenuEditor({ menu, onChange, base, issues, readOnly }: { menu: MenuRow; onChange: (next: MenuRow) => void; base: string; issues: Record<string, string>; readOnly: boolean }) {
  const focus = useFocusNext();
  const menuName = menu.label.trim() || "this menu";
  const setColumns = (columns: MenuColumn[]) => onChange({ ...menu, columns });
  const updateColumn = (key: string, change: Partial<MenuColumn>) => setColumns(menu.columns.map((c) => (c.key === key ? { ...c, ...change } : c)));
  const fullColumns = menu.columns.length >= NAV_LIMITS.columns;

  return (
    <div className="mt-3 space-y-3 border-t border-line pt-3 sm:pl-16">
      {issues[`${base}.columns`] && <p className="text-xs text-danger">{issues[`${base}.columns`]}</p>}
      <ol className="space-y-3">
        {menu.columns.map((column, j) => {
          const colBase = `${base}.columns[${j}]`;
          const colName = column.title.trim() || `column ${j + 1}`;
          const fullItems = column.items.length >= NAV_LIMITS.columnItems;
          return (
            <li key={column.key} className="rounded-lg border border-line bg-surface p-3">
              <div className="flex items-start gap-2">
                <Columns3 aria-hidden="true" className="mt-2.5 h-4 w-4 shrink-0 text-subtle" />
                <TextField
                  label={`${menuName}, column ${j + 1}: title`}
                  value={column.title}
                  onChange={(v) => updateColumn(column.key, { title: v })}
                  max={80}
                  required
                  placeholder="Core features"
                  error={issues[`${colBase}.title`]}
                  readOnly={readOnly}
                  inputRef={focus.ref(column.key)}
                  className="flex-1"
                />
                {!readOnly && (
                  <div className="mt-6">
                    <RowButtons
                      name={colName}
                      index={j}
                      count={menu.columns.length}
                      onMove={(by) => setColumns(moveItem(menu.columns, j, by))}
                      onRemove={() => setColumns(menu.columns.filter((c) => c.key !== column.key))}
                      removeLabel={`Remove ${colName} and its links`}
                    />
                  </div>
                )}
              </div>
              {issues[`${colBase}.items`] && <p className="mt-2 text-xs text-danger">{issues[`${colBase}.items`]}</p>}
              <ol className="mt-3 space-y-2">
                {column.items.map((entry, k) => {
                  const itemBase = `${colBase}.items[${k}]`;
                  const entryName = entry.label.trim() || `link ${k + 1}`;
                  const setEntry = (change: Partial<MenuEntry>) => updateColumn(column.key, { items: column.items.map((e) => (e.key === entry.key ? { ...e, ...change } : e)) });
                  return (
                    <li key={entry.key} className="rounded-md border border-line/70 bg-surface-sunken/40 p-2.5">
                      <div className="flex items-start gap-2">
                        <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
                          <TextField
                            label={`${colName}, link ${k + 1}: label`}
                            srOnlyLabel
                            value={entry.label}
                            onChange={(v) => setEntry({ label: v })}
                            max={80}
                            placeholder="CRM"
                            error={issues[`${itemBase}.label`]}
                            readOnly={readOnly}
                            inputRef={focus.ref(entry.key)}
                          />
                          <TextField
                            label={`${colName}, link ${k + 1}: address`}
                            srOnlyLabel
                            value={entry.href}
                            onChange={(v) => setEntry({ href: v })}
                            placeholder="/product/crm"
                            error={issues[`${itemBase}.href`] ?? hrefProblem(entry.href)}
                            readOnly={readOnly}
                            mono
                            inputMode="url"
                          />
                          <TextField
                            label={`${colName}, link ${k + 1}: description`}
                            srOnlyLabel
                            value={entry.description}
                            onChange={(v) => setEntry({ description: v })}
                            max={NAV_LIMITS.description}
                            placeholder="A line on what the page is (optional)"
                            error={issues[`${itemBase}.description`]}
                            readOnly={readOnly}
                            className="sm:col-span-2"
                          />
                        </div>
                        {!readOnly && (
                          <div className="mt-1">
                            <RowButtons
                              name={entryName}
                              index={k}
                              count={column.items.length}
                              onMove={(by) => updateColumn(column.key, { items: moveItem(column.items, k, by) })}
                              onRemove={() => updateColumn(column.key, { items: column.items.filter((e) => e.key !== entry.key) })}
                            />
                          </div>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
              {!readOnly && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="-ml-2 mt-2"
                  disabled={fullItems}
                  onClick={() => {
                    const key = newRowKey();
                    focus.want(key);
                    updateColumn(column.key, { items: [...column.items, { key, label: "", href: "", description: "" }] });
                  }}
                >
                  <Plus aria-hidden="true" className="h-4 w-4" />
                  {fullItems ? `A column takes ${NAV_LIMITS.columnItems} links` : `Add a link to ${colName}`}
                </Button>
              )}
            </li>
          );
        })}
      </ol>
      {!readOnly && (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={fullColumns}
          onClick={() => {
            const key = newRowKey();
            focus.want(key);
            setColumns([...menu.columns, { key, title: "", items: [{ key: newRowKey(), label: "", href: "", description: "" }] }]);
          }}
        >
          <Plus aria-hidden="true" className="h-4 w-4" />
          {fullColumns ? `A menu takes ${NAV_LIMITS.columns} columns` : `Add a column to ${menuName}`}
        </Button>
      )}
      {menu.footer ? (
        <fieldset className="min-w-0 rounded-lg border border-line bg-surface p-3">
          <legend className="px-1 text-xs font-medium text-muted">Along the foot of {menuName}</legend>
          <div className="flex items-start gap-2">
            <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
              <TextField
                label={`${menuName}, foot link: label`}
                srOnlyLabel
                value={menu.footer.label}
                onChange={(v) => onChange({ ...menu, footer: { ...menu.footer!, label: v } })}
                max={80}
                placeholder="See every feature"
                error={issues[`${base}.footer.label`]}
                readOnly={readOnly}
              />
              <TextField
                label={`${menuName}, foot link: address`}
                srOnlyLabel
                value={menu.footer.href}
                onChange={(v) => onChange({ ...menu, footer: { ...menu.footer!, href: v } })}
                placeholder="/product"
                error={issues[`${base}.footer.href`] ?? hrefProblem(menu.footer.href)}
                readOnly={readOnly}
                mono
                inputMode="url"
              />
            </div>
            {!readOnly && <IconButton icon={X} label={`Remove the link along the foot of ${menuName}`} tone="danger" onClick={() => onChange({ ...menu, footer: null })} />}
          </div>
        </fieldset>
      ) : (
        !readOnly && (
          <Button type="button" variant="ghost" size="sm" className="-ml-2" onClick={() => onChange({ ...menu, footer: { label: "", href: "" } })}>
            <Plus aria-hidden="true" className="h-4 w-4" />
            Add a link along the menu&apos;s foot
          </Button>
        )
      )}
    </div>
  );
}

// ─── The footer ──────────────────────────────────────────────────────────────────────────────────

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
            {columns.length} of {MAX_FOOTER_COLUMNS}
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
                  max={NAV_LIMITS.footerLinks}
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
          disabled={columns.length >= MAX_FOOTER_COLUMNS}
          onClick={() => {
            const key = newRowKey();
            focusColumn.current = key;
            onChange([...columns, { key, title: "", links: [] }]);
          }}
        >
          <Plus aria-hidden="true" className="h-4 w-4" />
          {columns.length >= MAX_FOOTER_COLUMNS ? `The footer takes ${MAX_FOOTER_COLUMNS} columns` : "Add a column"}
        </Button>
      )}
    </div>
  );
}

// ─── The preview ─────────────────────────────────────────────────────────────────────────────────

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
 * sign-up button can be shown in either form, and any menu opened to see its panel.
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
  const [shownMenu, setShownMenu] = useState<string | null>(null);
  const cta = asOpen ? form.signupOpen : form.signupInvite;
  const t = (text: string) => fill(text, settings, trialDays);
  const nameId = useId();
  const menus = form.nav.filter((row): row is MenuRow => row.kind === "menu");
  const menu = menus.find((m) => m.key === shownMenu) ?? null;

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
      {menus.length > 0 && (
        <div role="group" aria-label="Open a menu in the preview" className="flex flex-wrap items-center gap-1 border-b border-line px-4 py-2">
          <span className="mr-1 text-[11px] text-subtle">Open:</span>
          {menus.map((m, i) => (
            <button
              key={m.key}
              type="button"
              aria-pressed={shownMenu === m.key}
              onClick={() => setShownMenu((s) => (s === m.key ? null : m.key))}
              className={cn("h-6 rounded-[6px] border px-2 text-[11px] font-medium transition-colors", shownMenu === m.key ? "border-line-strong bg-surface-sunken text-text" : "border-line text-muted hover:text-text")}
            >
              {t(m.label) || `Menu ${i + 1}`}
            </button>
          ))}
        </div>
      )}

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
              <span className="text-[11px] text-subtle italic">no menu items</span>
            ) : (
              form.nav.map((row) => (
                <span key={row.key} className={cn("inline-flex items-center gap-0.5 truncate text-[11px]", row.key === shownMenu ? "text-text" : "text-muted")}>
                  {t(row.label) || "…"}
                  {row.kind === "menu" && <ChevronDown className="h-2.5 w-2.5" />}
                </span>
              ))
            )}
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            <span className="text-[11px] font-medium text-text">{t(form.signin.label) || "…"}</span>
            <span className="rounded-md bg-brand px-2 py-1 text-[11px] font-medium text-brand-contrast">{t(cta.label) || "…"}</span>
          </span>
        </div>

        {menu && (
          <div className="border-b border-line bg-surface-sunken/60 px-3 py-3">
            <div className="rounded-lg border border-line bg-surface p-3 shadow-md">
              <div className={cn("grid gap-3", menu.columns.length >= 3 ? "grid-cols-3" : menu.columns.length === 2 ? "grid-cols-2" : "grid-cols-1")}>
                {menu.columns.map((column) => (
                  <div key={column.key} className="min-w-0">
                    <p className="truncate text-[9px] font-semibold tracking-wide text-subtle uppercase">{t(column.title) || "…"}</p>
                    <ul className="mt-1 space-y-1">
                      {column.items.map((entry) => (
                        <li key={entry.key} className="min-w-0">
                          <p className="truncate text-[11px] font-medium text-text">{t(entry.label) || "…"}</p>
                          {entry.description.trim() && <p className="line-clamp-2 text-[10px] leading-snug text-muted">{t(entry.description)}</p>}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
              {menu.footer && <p className="mt-2 border-t border-line pt-2 text-[11px] font-medium text-brand">{t(menu.footer.label) || "…"} →</p>}
            </div>
          </div>
        )}

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
