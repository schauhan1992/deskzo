"use client";

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronDown, Copy, ImagePlus, Plus, Trash2, TriangleAlert, X } from "lucide-react";
import { ICON_NAMES, PREVIEW_KINDS, type IconName, type PreviewKind, type SiteAction, type SiteLink, type SiteMedia } from "@/components/site/blocks/types";
import { SiteIcon } from "@/components/site/icons";
import { IssueScope, useEditorEnv, useIssueCount, useIssuesAt } from "@/components/cms/editor/editor-context";
import { insertItem, moveItem, removeItem, replaceItem } from "@/components/cms/editor/doc-utils";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { isAllowedHref, isCalendarDate, isSitePath, mediaIdOf } from "@/lib/cms/validate";
import { cn } from "@/lib/utils";

/**
 * The block editor's form controls. Every one is labelled (a `<Label htmlFor>` on the control's own
 * id, or a legend for a group), shows the issues for its own path under it — from the browser's
 * check as you type and from the server's on save — and says how long a text may be.
 *
 * Values in, values out: each field takes the current value and hands the next one to `onChange`.
 * Read-only mode is a `<fieldset disabled>` around the whole form, so nothing here needs to know.
 */

const LINK_HINT = "A page on this site (/pricing), an #anchor on this page, https://… or mailto:…";

export const PREVIEW_LABELS: Record<PreviewKind, string> = { pipeline: "Sales pipeline", invoice: "Invoice", attendance: "Attendance" };

// ─── The frame every field sits in ───────────────────────────────────────────────────────────────

function Messages({ id, messages }: { id: string; messages: string[] }) {
  if (!messages.length) return null;
  return (
    <ul id={id} className="space-y-0.5">
      {messages.map((message, i) => (
        <li key={i} className="flex items-start gap-1 text-xs text-danger">
          <TriangleAlert aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0" />
          {message}
        </li>
      ))}
    </ul>
  );
}

function Counter({ id, length, max }: { id: string; length: number; max: number }) {
  const over = length > max;
  const near = !over && length > max * 0.9;
  return (
    <span id={id} className={cn("shrink-0 text-[11px] tabular-nums", over ? "font-medium text-danger" : near ? "text-warning" : "text-subtle")}>
      {length.toLocaleString("en-IN")}/{max.toLocaleString("en-IN")}
      <span className="sr-only"> characters</span>
    </span>
  );
}

const Optional = () => <span className="font-normal text-subtle"> (optional)</span>;

// ─── Text ────────────────────────────────────────────────────────────────────────────────────────

export function TextField({
  label,
  name,
  value,
  onChange,
  max,
  required = false,
  multiline = false,
  rows = 3,
  placeholder,
  hint,
  className,
}: {
  label: string;
  /** The field's path inside the current issue scope ("heading", "title"). */
  name: string;
  value: string | undefined;
  onChange: (next: string) => void;
  max: number;
  required?: boolean;
  multiline?: boolean;
  rows?: number;
  placeholder?: string;
  hint?: ReactNode;
  className?: string;
}) {
  const id = useId();
  const messages = useIssuesAt(name);
  const text = value ?? "";
  const describedBy = [`${id}-count`, hint ? `${id}-hint` : "", messages.length ? `${id}-err` : ""].filter(Boolean).join(" ");
  return (
    <div className={cn("min-w-0 space-y-1.5", className)}>
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={id}>
          {label}
          {!required && <Optional />}
        </Label>
        <Counter id={`${id}-count`} length={text.length} max={max} />
      </div>
      {multiline ? (
        <Textarea
          id={id}
          value={text}
          rows={rows}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={messages.length ? true : undefined}
          aria-describedby={describedBy}
          className={cn(messages.length && "border-danger")}
        />
      ) : (
        <Input
          id={id}
          value={text}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={messages.length ? true : undefined}
          aria-describedby={describedBy}
          className={cn(messages.length && "border-danger")}
        />
      )}
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-subtle">
          {hint}
        </p>
      )}
      <Messages id={`${id}-err`} messages={messages} />
    </div>
  );
}

/** An optional #anchor, so a link can jump to this block ("/#modules"). */
export function AnchorField({ value, onChange, name = "anchor" }: { value: string | undefined; onChange: (next: string | undefined) => void; name?: string }) {
  const id = useId();
  const messages = useIssuesAt(name);
  const text = value ?? "";
  const bad = !!text && !/^[a-z][a-z0-9-]{0,47}$/.test(text.replace(/^#/, ""));
  return (
    <div className="min-w-0 space-y-1.5">
      <Label htmlFor={id}>
        Anchor
        <Optional />
      </Label>
      <div className="flex items-center">
        <span aria-hidden="true" className="grid h-9 place-items-center rounded-l-base border border-r-0 border-line-strong bg-surface-sunken px-2.5 text-sm text-subtle">
          #
        </span>
        <Input
          id={id}
          value={text.replace(/^#/, "")}
          placeholder="modules"
          onChange={(e) => onChange(e.target.value.trim() ? e.target.value.replace(/^#/, "").toLowerCase() : undefined)}
          aria-invalid={bad || messages.length ? true : undefined}
          aria-describedby={`${id}-hint`}
          className="rounded-l-none font-mono text-[13px]"
        />
      </div>
      <p id={`${id}-hint`} className={cn("text-xs", bad ? "text-danger" : "text-subtle")}>
        {bad ? "Lower-case letters, digits and hyphens, starting with a letter." : "Lets a link jump here, like /#modules."}
      </p>
      <Messages id={`${id}-err`} messages={messages} />
    </div>
  );
}

// ─── Lines of text (bullets, paragraphs) ─────────────────────────────────────────────────────────

export function LinesField({
  label,
  name,
  value,
  onChange,
  max,
  maxItems,
  required = false,
  multiline = false,
  itemNoun = "line",
  hint,
}: {
  label: string;
  name: string;
  value: string[] | undefined;
  onChange: (next: string[]) => void;
  max: number;
  maxItems: number;
  required?: boolean;
  multiline?: boolean;
  itemNoun?: string;
  hint?: string;
}) {
  const baseId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const messages = useIssuesAt(name);
  const lines = value ?? [];

  const focusLine = (index: number, atEnd = false) => {
    window.requestAnimationFrame(() => {
      const el = listRef.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-line="${index}"]`);
      if (!el) return;
      el.focus();
      if (atEnd) el.setSelectionRange(el.value.length, el.value.length);
    });
  };

  const add = (at = lines.length) => {
    if (lines.length >= maxItems) return;
    onChange(insertItem(lines, at, ""));
    focusLine(at);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>, index: number) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      add(index + 1);
    } else if (e.key === "Backspace" && !lines[index] && lines.length > 1) {
      e.preventDefault();
      onChange(removeItem(lines, index));
      focusLine(Math.max(0, index - 1), true);
    }
  };

  return (
    <fieldset className="min-w-0 space-y-1.5">
      <legend className="text-[13px] font-medium text-muted">
        {label}
        {!required && <Optional />}
      </legend>
      {hint && <p className="text-xs text-subtle">{hint}</p>}
      <div ref={listRef} className="space-y-1.5">
        {lines.map((line, i) => {
          const lineId = `${baseId}-${i}`;
          return (
            <LineRow
              key={i}
              id={lineId}
              index={i}
              count={lines.length}
              label={`${label}, ${itemNoun} ${i + 1}`}
              name={`${name}[${i}]`}
              value={line}
              max={max}
              multiline={multiline}
              onChange={(next) => onChange(replaceItem(lines, i, next))}
              onKeyDown={(e) => onKeyDown(e, i)}
              onMove={(to) => {
                onChange(moveItem(lines, i, to));
                focusLine(to);
              }}
              onRemove={() => {
                onChange(removeItem(lines, i));
                if (lines.length > 1) focusLine(Math.max(0, i - 1));
              }}
            />
          );
        })}
      </div>
      {lines.length < maxItems ? (
        <Button type="button" variant="ghost" size="sm" onClick={() => add()} className="-ml-2">
          <Plus aria-hidden="true" className="h-4 w-4" />
          Add {itemNoun}
        </Button>
      ) : (
        <p className="text-xs text-subtle">That is the most this can hold ({maxItems}).</p>
      )}
      <Messages id={`${baseId}-err`} messages={messages} />
    </fieldset>
  );
}

function LineRow({
  id,
  index,
  count,
  label,
  name,
  value,
  max,
  multiline,
  onChange,
  onKeyDown,
  onMove,
  onRemove,
}: {
  id: string;
  index: number;
  count: number;
  label: string;
  name: string;
  value: string;
  max: number;
  multiline: boolean;
  onChange: (next: string) => void;
  onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
  onMove: (to: number) => void;
  onRemove: () => void;
}) {
  const messages = useIssuesAt(name);
  const over = value.length > max;
  return (
    <div className="min-w-0">
      <div className="flex items-start gap-1">
        {multiline ? (
          <Textarea id={id} data-line={index} aria-label={label} value={value} rows={2} onChange={(e) => onChange(e.target.value)} aria-invalid={over || messages.length ? true : undefined} className="min-h-14 flex-1" />
        ) : (
          <Input id={id} data-line={index} aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown} aria-invalid={over || messages.length ? true : undefined} className="flex-1" />
        )}
        <div className="flex shrink-0 items-center pt-1">
          <IconButton icon={ArrowUp} label={`Move ${label} up`} onClick={() => onMove(index - 1)} disabled={index === 0} />
          <IconButton icon={ArrowDown} label={`Move ${label} down`} onClick={() => onMove(index + 1)} disabled={index === count - 1} />
          <IconButton icon={X} tone="danger" label={`Remove ${label}`} onClick={onRemove} />
        </div>
      </div>
      {over && <p className="mt-0.5 text-xs text-danger">{`Keep this to ${max.toLocaleString("en-IN")} characters (it has ${value.length.toLocaleString("en-IN")}).`}</p>}
      {!over && messages.map((m, i) => (
        <p key={i} className="mt-0.5 text-xs text-danger">
          {m}
        </p>
      ))}
    </div>
  );
}

// ─── Choices ─────────────────────────────────────────────────────────────────────────────────────

export function SelectField<V extends string>({
  label,
  name,
  value,
  options,
  onChange,
  required = true,
  emptyLabel,
  hint,
}: {
  label: string;
  name: string;
  value: V | undefined;
  options: readonly { value: V; label: string }[];
  onChange: (next: V | undefined) => void;
  required?: boolean;
  /** Offered first when the choice is optional ("No icon"). */
  emptyLabel?: string;
  hint?: string;
}) {
  const id = useId();
  const messages = useIssuesAt(name);
  return (
    <div className="min-w-0 space-y-1.5">
      <Label htmlFor={id}>
        {label}
        {!required && <Optional />}
      </Label>
      <Select id={id} value={value ?? ""} onChange={(e) => onChange((e.target.value || undefined) as V | undefined)} aria-invalid={messages.length ? true : undefined}>
        {(!required || !value) && <option value="">{emptyLabel ?? "Choose…"}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
      {hint && <p className="text-xs text-subtle">{hint}</p>}
      <Messages id={`${id}-err`} messages={messages} />
    </div>
  );
}

/** A few options side by side — radio buttons, so arrow keys move between them. */
export function ChoiceField<V extends string | number>({
  label,
  name,
  value,
  options,
  onChange,
  hint,
}: {
  label: string;
  name: string;
  value: V;
  options: readonly { value: V; label: string }[];
  onChange: (next: V) => void;
  hint?: string;
}) {
  const group = useId();
  const messages = useIssuesAt(name);
  return (
    <fieldset className="min-w-0 space-y-1.5">
      <legend className="text-[13px] font-medium text-muted">{label}</legend>
      <div className="inline-flex max-w-full flex-wrap rounded-base border border-line bg-surface-sunken p-0.5">
        {options.map((o) => {
          const on = o.value === value;
          return (
            <label
              key={String(o.value)}
              className={cn(
                "relative inline-flex h-8 cursor-pointer items-center rounded-[6px] px-3 text-[13px] font-medium whitespace-nowrap has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus",
                on ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text",
              )}
            >
              <input type="radio" name={group} checked={on} onChange={() => onChange(o.value)} className="sr-only" />
              {o.label}
            </label>
          );
        })}
      </div>
      {hint && <p className="text-xs text-subtle">{hint}</p>}
      <Messages id={`${group}-err`} messages={messages} />
    </fieldset>
  );
}

export function CheckField({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (next: boolean) => void; hint?: string }) {
  return (
    <div className="space-y-0.5">
      <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-text select-none">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 rounded border-line-strong accent-brand" />
        {label}
      </label>
      {hint && <p className="pl-6 text-xs text-subtle">{hint}</p>}
    </div>
  );
}

const ICON_OPTIONS = ICON_NAMES.map((name) => ({ value: name, label: name.replace(/-/g, " ").replace(/^\w/, (c) => c.toUpperCase()) }));

export function IconField({ label = "Icon", name, value, onChange, required = false }: { label?: string; name: string; value: IconName | undefined; onChange: (next: IconName | undefined) => void; required?: boolean }) {
  const id = useId();
  const messages = useIssuesAt(name);
  return (
    <div className="min-w-0 space-y-1.5">
      <Label htmlFor={id}>
        {label}
        {!required && <Optional />}
      </Label>
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className="grid h-9 w-9 shrink-0 place-items-center rounded-base border border-line bg-brand-subtle text-brand">
          {value ? <SiteIcon name={value} className="h-4 w-4" /> : <span className="text-xs text-subtle">—</span>}
        </span>
        <Select id={id} value={value ?? ""} onChange={(e) => onChange((e.target.value || undefined) as IconName | undefined)} aria-invalid={messages.length ? true : undefined}>
          {(!required || !value) && <option value="">{required ? "Choose an icon…" : "No icon"}</option>}
          {ICON_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </div>
      <Messages id={`${id}-err`} messages={messages} />
    </div>
  );
}

// ─── Links and buttons ───────────────────────────────────────────────────────────────────────────

export function HrefField({
  label = "Link",
  name,
  value,
  onChange,
  required = false,
  webOnly = false,
  internalOnly = false,
}: {
  label?: string;
  name: string;
  value: string | undefined;
  onChange: (next: string) => void;
  required?: boolean;
  webOnly?: boolean;
  /** A page on this site only ("/pricing") — the related-links and page-map blocks. */
  internalOnly?: boolean;
}) {
  const id = useId();
  const { sitePaths } = useEditorEnv();
  const messages = useIssuesAt(name);
  const text = value ?? "";
  const bad = !!text.trim() && (!isAllowedHref(text, webOnly) || (internalOnly && !isSitePath(text)));
  const mailto = /^mailto:/i.test(text.trim());
  return (
    <div className="min-w-0 space-y-1.5">
      <Label htmlFor={id}>
        {label}
        {!required && <Optional />}
      </Label>
      <Input
        id={id}
        value={text}
        list={webOnly ? undefined : `${id}-paths`}
        placeholder={webOnly ? "https://…" : internalOnly ? "/product/crm" : "/pricing"}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        autoCapitalize="off"
        aria-invalid={bad || messages.length ? true : undefined}
        aria-describedby={`${id}-hint`}
        className={cn("font-mono text-[13px]", (bad || messages.length > 0) && "border-danger")}
      />
      {!webOnly && (
        <datalist id={`${id}-paths`}>
          {sitePaths.map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>
      )}
      <p id={`${id}-hint`} className={cn("text-xs", bad ? "text-danger" : "text-subtle")}>
        {bad
          ? webOnly
            ? "Use an http(s) address."
            : internalOnly
              ? "Link to a page on this site, like /pricing — this block never links elsewhere."
              : `Not a link the site can use. ${LINK_HINT}.`
          : internalOnly
            ? "A page on this site, like /pricing or /product/crm."
            : mailto
              ? "Opens the visitor's email app, addressed to this one address."
              : webOnly
                ? "An http(s) address."
                : LINK_HINT}
      </p>
      <Messages id={`${id}-err`} messages={messages} />
    </div>
  );
}

/** A calendar date, stored as "yyyy-mm-dd" — the browser's own date picker. */
export function DateField({ label, name, value, onChange, required = false, hint }: { label: string; name: string; value: string | undefined; onChange: (next: string) => void; required?: boolean; hint?: string }) {
  const id = useId();
  const messages = useIssuesAt(name);
  const text = value ?? "";
  const bad = !!text && !isCalendarDate(text);
  return (
    <div className="min-w-0 space-y-1.5">
      <Label htmlFor={id}>
        {label}
        {!required && <Optional />}
      </Label>
      <Input id={id} type="date" value={text} onChange={(e) => onChange(e.target.value)} aria-invalid={bad || messages.length ? true : undefined} aria-describedby={hint ? `${id}-hint` : undefined} className="w-auto" />
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-subtle">
          {hint}
        </p>
      )}
      <Messages id={`${id}-err`} messages={messages} />
    </div>
  );
}

type MarkKind = "yes" | "partial" | "no" | "words";
const MARK_KINDS: readonly MarkKind[] = ["yes", "partial", "no"];

/** A comparison cell: yes, partly or no (the site shows a mark and the word), or words of one's own. */
export function MarkField({ label, name, value, onChange }: { label: string; name: string; value: string | undefined; onChange: (next: string) => void }) {
  const text = value ?? "";
  const kind: MarkKind = (MARK_KINDS as readonly string[]).includes(text.trim().toLowerCase()) ? (text.trim().toLowerCase() as MarkKind) : "words";
  return (
    <div className="min-w-0 space-y-2">
      <ChoiceField
        label={label}
        name={`${name}.kind`}
        value={kind}
        onChange={(next) => onChange(next === "words" ? "" : next)}
        options={[
          { value: "yes", label: "Yes" },
          { value: "partial", label: "Partly" },
          { value: "no", label: "No" },
          { value: "words", label: "In words" },
        ]}
      />
      {kind === "words" && <TextField label={`${label}, in words`} name={name} value={text} onChange={onChange} max={120} required placeholder="From ₹999 a month" />}
    </div>
  );
}

/** An optional link: a label and an address, or "Add a link". */
export function LinkField({ label, name, value, onChange }: { label: string; name: string; value: SiteLink | undefined; onChange: (next: SiteLink | undefined) => void }) {
  const count = useIssueCount(name);
  if (!value) {
    return (
      <div>
        <Button type="button" variant="ghost" size="sm" onClick={() => onChange({ label: "", href: "" })} className="-ml-2">
          <Plus aria-hidden="true" className="h-4 w-4" />
          Add {label.toLowerCase()}
        </Button>
      </div>
    );
  }
  return (
    <fieldset className={cn("min-w-0 space-y-3 rounded-lg border p-3", count ? "border-danger/50" : "border-line")}>
      <legend className="-ml-1 px-1 text-[13px] font-medium text-muted">{label}</legend>
      <IssueScope prefix={name}>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="Words on the link" name="label" value={value.label} onChange={(next) => onChange({ ...value, label: next })} max={80} required />
          <HrefField name="href" value={value.href} onChange={(next) => onChange({ ...value, href: next })} required />
        </div>
      </IssueScope>
      <Button type="button" variant="ghost" size="sm" onClick={() => onChange(undefined)} className="-ml-2 text-danger hover:text-danger">
        <Trash2 aria-hidden="true" className="h-4 w-4" />
        Remove {label.toLowerCase()}
      </Button>
    </fieldset>
  );
}

type ActionKind = "none" | "signup" | "link";

/** A button: none, the site's own signup button, or a link with its own words. */
export function ActionField({ label, name, value, onChange }: { label: string; name: string; value: SiteAction | undefined; onChange: (next: SiteAction | undefined) => void }) {
  const kind: ActionKind = value ? value.kind : "none";
  const count = useIssueCount(name);
  const choose = (next: ActionKind) => {
    if (next === kind) return;
    if (next === "none") onChange(undefined);
    else if (next === "signup") onChange({ kind: "signup" });
    else onChange({ kind: "link", label: "", href: "" });
  };
  return (
    <fieldset className={cn("min-w-0 space-y-3 rounded-lg border p-3", count ? "border-danger/50" : "border-line")}>
      <legend className="-ml-1 px-1 text-[13px] font-medium text-muted">{label}</legend>
      <ChoiceField
        label="What it is"
        name={`${name}.kind`}
        value={kind}
        onChange={choose}
        options={[
          { value: "none", label: "None" },
          { value: "signup", label: "Signup button" },
          { value: "link", label: "Link" },
        ]}
      />
      {value?.kind === "signup" && <p className="text-xs text-subtle">Follows the signup setting: “Start free trial” while anyone can sign up, “Request an invitation” while signup is by invitation. Its words are set in Navigation.</p>}
      {value?.kind === "link" && (
        <IssueScope prefix={name}>
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField label="Button words" name="label" value={value.label} onChange={(next) => onChange({ ...value, label: next })} max={80} required />
            <HrefField name="href" value={value.href} onChange={(next) => onChange({ ...value, href: next })} required />
          </div>
        </IssueScope>
      )}
    </fieldset>
  );
}

// ─── Images ──────────────────────────────────────────────────────────────────────────────────────

/** An image from the media library, as "/media/<id>" — chosen in the picker, never typed. */
export function ImageField({ label, name, value, onChange, required = false, hint }: { label: string; name: string; value: string | undefined; onChange: (next: string | undefined) => void; required?: boolean; hint?: string }) {
  const { media, pickImage } = useEditorEnv();
  const messages = useIssuesAt(name);
  const labelId = useId();
  const id = mediaIdOf(value);
  const row = id ? media[id] : undefined;
  const choose = async () => {
    const picked = await pickImage();
    if (picked) onChange(picked.url);
  };
  return (
    <div role="group" aria-labelledby={labelId} className="min-w-0 space-y-1.5">
      <p id={labelId} className="text-[13px] font-medium text-muted">
        {label}
        {!required && <Optional />}
      </p>
      <div className={cn("flex items-center gap-3 rounded-lg border p-2", messages.length ? "border-danger/50" : "border-line")}>
        <div className="grid h-16 w-24 shrink-0 place-items-center overflow-hidden rounded-md border border-line bg-surface-sunken">
          {id ? (
            // A library image, served by the CMS host's /media route.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={`/media/${id}`} alt={row?.alt ?? ""} className="h-full w-full object-contain" />
          ) : (
            <ImagePlus aria-hidden="true" className="h-5 w-5 text-subtle" />
          )}
        </div>
        <div className="min-w-0 flex-1 text-xs">
          {id ? (
            <>
              <p className="truncate font-medium text-text">{row?.filename ?? "Library image"}</p>
              {row?.needsAlt ? (
                <p className="mt-0.5 text-warning">
                  No alt text in the library yet —{" "}
                  <a href={`/media?id=${id}`} target="_blank" rel="noopener noreferrer" className="underline">
                    add it
                  </a>{" "}
                  before publishing.
                </p>
              ) : row ? (
                <p className="mt-0.5 truncate text-muted">Alt: {row.alt}</p>
              ) : null}
            </>
          ) : (
            <p className="text-muted">No image chosen.</p>
          )}
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <Button type="button" variant="secondary" size="sm" onClick={choose}>
              {id ? "Replace…" : "Choose image…"}
            </Button>
            {id && (
              <Button type="button" variant="ghost" size="sm" onClick={() => onChange(undefined)} className="text-danger hover:text-danger">
                Remove
              </Button>
            )}
          </div>
        </div>
      </div>
      {hint && <p className="text-xs text-subtle">{hint}</p>}
      <Messages id={`${labelId}-err`} messages={messages} />
    </div>
  );
}

type MediaKind = "none" | "preview" | "image";

/** A block's picture: one of the drawn product previews, or a library image with its alt text. */
export function MediaField({ label, name, value, onChange, required = false }: { label: string; name: string; value: SiteMedia | undefined; onChange: (next: SiteMedia | undefined) => void; required?: boolean }) {
  const { media } = useEditorEnv();
  const kind: MediaKind = value ? value.kind : "none";
  const count = useIssueCount(name);
  const choose = (next: MediaKind) => {
    if (next === kind) return;
    if (next === "none") onChange(undefined);
    else if (next === "preview") onChange({ kind: "preview", preview: "pipeline" });
    else onChange({ kind: "image", src: "", alt: "" });
  };
  const options: { value: MediaKind; label: string }[] = [
    ...(required ? [] : [{ value: "none" as const, label: "None" }]),
    { value: "preview", label: "Product preview" },
    { value: "image", label: "Image" },
  ];
  const libraryAlt = value?.kind === "image" ? media[mediaIdOf(value.src) ?? ""]?.alt : undefined;
  return (
    <fieldset className={cn("min-w-0 space-y-3 rounded-lg border p-3", count ? "border-danger/50" : "border-line")}>
      <legend className="-ml-1 px-1 text-[13px] font-medium text-muted">
        {label}
        {!required && <Optional />}
      </legend>
      <ChoiceField label="Show" name={`${name}.kind`} value={kind} onChange={choose} options={options} />
      <IssueScope prefix={name}>
        {value?.kind === "preview" && (
          <SelectField
            label="Which screen"
            name="preview"
            value={value.preview}
            onChange={(next) => onChange({ kind: "preview", preview: next ?? "pipeline" })}
            options={PREVIEW_KINDS.map((k) => ({ value: k, label: PREVIEW_LABELS[k] }))}
            hint="Drawn by the site and marked “Sample data”."
          />
        )}
        {value?.kind === "image" && (
          <div className="space-y-3">
            <ImageField label="Image" name="src" value={value.src || undefined} onChange={(src) => onChange({ ...value, src: src ?? "" })} required />
            <TextField
              label="Alt text on this block"
              name="alt"
              value={value.alt}
              onChange={(alt) => onChange({ ...value, alt })}
              max={200}
              required
              hint={
                libraryAlt && libraryAlt !== value.alt ? (
                  <button type="button" className="font-medium text-brand hover:underline" onClick={() => onChange({ ...value, alt: libraryAlt })}>
                    Use the library&apos;s: “{libraryAlt.length > 60 ? `${libraryAlt.slice(0, 59)}…` : libraryAlt}”
                  </button>
                ) : (
                  "What the picture shows, for people who can't see it."
                )
              }
            />
          </div>
        )}
      </IssueScope>
    </fieldset>
  );
}

// ─── Repeatable items ────────────────────────────────────────────────────────────────────────────

/**
 * A list of items (features, questions, figures): each in its own card that folds away, with move
 * up and down, duplicate and remove — buttons, not dragging — and "Add" at the end.
 */
export function ListField<T>({
  label,
  name,
  items,
  onChange,
  newItem,
  itemNoun,
  itemTitle,
  maxItems,
  required = true,
  hint,
  render,
}: {
  label: string;
  name: string;
  items: T[] | undefined;
  onChange: (next: T[]) => void;
  newItem: () => T;
  itemNoun: string;
  itemTitle: (item: T, index: number) => string;
  maxItems: number;
  required?: boolean;
  hint?: string;
  render: (item: T, set: (next: T) => void, index: number) => ReactNode;
}) {
  const list = items ?? [];
  const rootRef = useRef<HTMLFieldSetElement>(null);
  const messages = useIssuesAt(name);
  // Which cards are folded, by position; a list of a few starts open, a long one folded.
  const { readOnly } = useEditorEnv();
  const [folded, setFolded] = useState<boolean[]>(() => list.map(() => !readOnly && list.length > 4));
  const isFolded = (i: number) => folded[i] ?? false;

  const focusCard = (index: number, action: string) => {
    window.requestAnimationFrame(() => {
      const card = rootRef.current?.querySelector<HTMLElement>(`[data-item="${index}"]`);
      (card?.querySelector<HTMLElement>(`[data-action="${action}"]:not([disabled])`) ?? card?.querySelector<HTMLElement>("[data-action=toggle]"))?.focus();
    });
  };

  const move = (from: number, to: number) => {
    onChange(moveItem(list, from, to));
    setFolded((f) => moveItem(list.map((_, i) => f[i] ?? false), from, to));
    focusCard(to, to < from ? "up" : "down");
  };
  const duplicate = (i: number) => {
    if (list.length >= maxItems) return;
    onChange(insertItem(list, i + 1, structuredClone(list[i])));
    setFolded((f) => insertItem(list.map((_, j) => f[j] ?? false), i + 1, false));
    focusCard(i + 1, "toggle");
  };
  const remove = (i: number) => {
    onChange(removeItem(list, i));
    setFolded((f) => removeItem(list.map((_, j) => f[j] ?? false), i));
    focusCard(Math.max(0, i - 1), "toggle");
  };
  const add = () => {
    if (list.length >= maxItems) return;
    onChange([...list, newItem()]);
    setFolded((f) => [...list.map((_, j) => f[j] ?? false), false]);
    focusCard(list.length, "toggle");
  };

  return (
    <fieldset ref={rootRef} className="min-w-0 space-y-2">
      <legend className="flex w-full items-center justify-between gap-2 text-[13px] font-medium text-muted">
        <span>
          {label}
          {!required && <Optional />}
          <span className="ml-1.5 font-normal text-subtle tabular-nums">
            {list.length}/{maxItems}
          </span>
        </span>
      </legend>
      {hint && <p className="text-xs text-subtle">{hint}</p>}
      <Messages id={`${name}-err`} messages={messages} />
      <div className="space-y-2">
        {list.map((item, i) => (
          <ListItemCard
            key={i}
            index={i}
            count={list.length}
            name={`${name}[${i}]`}
            noun={itemNoun}
            title={itemTitle(item, i)}
            folded={isFolded(i)}
            canDuplicate={list.length < maxItems}
            onToggle={() => setFolded((f) => replaceItem(list.map((_, j) => f[j] ?? false), i, !isFolded(i)))}
            onMove={(to) => move(i, to)}
            onDuplicate={() => duplicate(i)}
            onRemove={() => remove(i)}
          >
            {render(item, (next) => onChange(replaceItem(list, i, next)), i)}
          </ListItemCard>
        ))}
      </div>
      {list.length < maxItems ? (
        <Button type="button" variant="secondary" size="sm" onClick={add}>
          <Plus aria-hidden="true" className="h-4 w-4" />
          Add {itemNoun}
        </Button>
      ) : (
        <p className="text-xs text-subtle">
          That is the most this can hold ({maxItems} {itemNoun}s).
        </p>
      )}
    </fieldset>
  );
}

function ListItemCard({
  index,
  count,
  name,
  noun,
  title,
  folded,
  canDuplicate,
  onToggle,
  onMove,
  onDuplicate,
  onRemove,
  children,
}: {
  index: number;
  count: number;
  name: string;
  noun: string;
  title: string;
  folded: boolean;
  canDuplicate: boolean;
  onToggle: () => void;
  onMove: (to: number) => void;
  onDuplicate: () => void;
  onRemove: () => void;
  children: ReactNode;
}) {
  const bodyId = useId();
  const issues = useIssueCount(name);
  const itemLabel = `${noun.charAt(0).toUpperCase()}${noun.slice(1)} ${index + 1}`;
  return (
    <div data-item={index} className={cn("min-w-0 rounded-lg border bg-surface", issues ? "border-danger/50" : "border-line")}>
      <div className="flex items-center gap-1 pr-1">
        <button
          type="button"
          data-action="toggle"
          aria-expanded={!folded}
          aria-controls={bodyId}
          onClick={onToggle}
          onKeyDown={(e) => {
            if (!e.altKey) return;
            if (e.key === "ArrowUp" && index > 0) {
              e.preventDefault();
              onMove(index - 1);
            } else if (e.key === "ArrowDown" && index < count - 1) {
              e.preventDefault();
              onMove(index + 1);
            }
          }}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-l-lg px-3 py-2 text-left text-sm hover:bg-surface-sunken"
        >
          <ChevronDown aria-hidden="true" className={cn("h-4 w-4 shrink-0 text-subtle transition-transform", folded && "-rotate-90")} />
          <span className="shrink-0 font-medium text-text">{itemLabel}</span>
          {title && <span className="min-w-0 truncate text-muted">{title}</span>}
          {issues > 0 && (
            <span className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-full bg-danger-bg px-1.5 text-[11px] font-medium text-danger">
              <TriangleAlert aria-hidden="true" className="h-3 w-3" />
              {issues}
              <span className="sr-only"> {issues === 1 ? "issue" : "issues"}</span>
            </span>
          )}
        </button>
        <IconButton icon={ArrowUp} data-action="up" label={`Move ${itemLabel} up`} onClick={() => onMove(index - 1)} disabled={index === 0} />
        <IconButton icon={ArrowDown} data-action="down" label={`Move ${itemLabel} down`} onClick={() => onMove(index + 1)} disabled={index === count - 1} />
        <IconButton icon={Copy} label={`Duplicate ${itemLabel}`} onClick={onDuplicate} disabled={!canDuplicate} />
        <IconButton icon={Trash2} tone="danger" label={`Remove ${itemLabel}`} onClick={onRemove} />
      </div>
      <div id={bodyId} hidden={folded} className="space-y-4 border-t border-line px-3 py-3">
        <IssueScope prefix={name}>{children}</IssueScope>
      </div>
    </div>
  );
}
