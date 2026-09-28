"use client";

import { useId, useRef, useState, type KeyboardEvent } from "react";
import { ArrowDown, ArrowUp, Bold, Heading2, Info, Italic, Link2, List, Pilcrow, Plus, Table, Trash2, TriangleAlert, X } from "lucide-react";
import type { RichInline, RichNode } from "@/components/site/blocks/types";
import { IssueScope, useIssueCount, useIssuesAt } from "@/components/cms/editor/editor-context";
import { ChoiceField, CheckField, LinesField, TextField, AnchorField } from "@/components/cms/editor/fields";
import { insertItem, moveItem, removeItem, replaceItem } from "@/components/cms/editor/doc-utils";
import { parseInline, plainInline, serializeInline } from "@/components/cms/editor/inline-markup";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { isAllowedHref, stableJson } from "@/lib/cms/validate";
import { cn } from "@/lib/utils";

/**
 * Structured rich text: a list of parts — headings, paragraphs, lists, tables and notes — each edited
 * with its own small form. Words inside a paragraph, list item, cell or note may be bold, italic or a
 * link, typed as **bold**, *italic* and [words](/address), with toolbar buttons (and Ctrl/⌘+B, I, K)
 * that write the markers for you. There is no HTML anywhere: the markers are read back into the
 * site's own structured runs (./inline-markup.ts).
 */

const NODE_LABEL: Record<RichNode["type"], string> = { heading: "Heading", paragraph: "Paragraph", list: "List", table: "Table", note: "Note" };

function newNode(type: RichNode["type"]): RichNode {
  switch (type) {
    case "heading":
      return { type: "heading", level: 2, text: "" };
    case "paragraph":
      return { type: "paragraph", text: "" };
    case "list":
      return { type: "list", items: [""] };
    case "table":
      return { type: "table", columns: ["Column 1", "Column 2"], rows: [["", ""]] };
    case "note":
      return { type: "note", tone: "info", text: "" };
  }
}

function nodeTitle(node: RichNode): string {
  const text = node.type === "heading" ? node.text : node.type === "list" ? plainInline(node.items[0]) : node.type === "table" ? node.columns.join(" · ") : plainInline(node.text);
  return text.length > 70 ? `${text.slice(0, 69)}…` : text;
}

const ADDABLE: { type: RichNode["type"]; icon: typeof Pilcrow }[] = [
  { type: "paragraph", icon: Pilcrow },
  { type: "heading", icon: Heading2 },
  { type: "list", icon: List },
  { type: "table", icon: Table },
  { type: "note", icon: Info },
];

export function RichTextField({ label, name, value, onChange, maxItems = 300 }: { label: string; name: string; value: RichNode[] | undefined; onChange: (next: RichNode[]) => void; maxItems?: number }) {
  const nodes = value ?? [];
  const rootRef = useRef<HTMLFieldSetElement>(null);
  const messages = useIssuesAt(name);

  const focusPart = (index: number) => {
    window.requestAnimationFrame(() => {
      rootRef.current?.querySelector<HTMLElement>(`[data-part="${index}"] textarea, [data-part="${index}"] input`)?.focus();
    });
  };
  const insert = (at: number, type: RichNode["type"]) => {
    if (nodes.length >= maxItems) return;
    onChange(insertItem(nodes, at, newNode(type)));
    focusPart(at);
  };

  return (
    <fieldset ref={rootRef} className="min-w-0 space-y-2">
      <legend className="text-[13px] font-medium text-muted">{label}</legend>
      <p className="text-xs text-subtle">
        In text: <code className="rounded bg-surface-sunken px-1">**bold**</code> <code className="rounded bg-surface-sunken px-1">*italic*</code>{" "}
        <code className="rounded bg-surface-sunken px-1">[words](/address)</code> — or select words and use the buttons.
      </p>
      {messages.map((m, i) => (
        <p key={i} className="flex items-center gap-1 text-xs text-danger">
          <TriangleAlert aria-hidden="true" className="h-3.5 w-3.5" />
          {m}
        </p>
      ))}
      <div className="space-y-2">
        {nodes.map((node, i) => (
          <PartCard
            key={i}
            index={i}
            count={nodes.length}
            name={`${name}[${i}]`}
            node={node}
            onChange={(next) => onChange(replaceItem(nodes, i, next))}
            onMove={(to) => onChange(moveItem(nodes, i, to))}
            onRemove={() => onChange(removeItem(nodes, i))}
          />
        ))}
      </div>
      {nodes.length < maxItems && (
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          <span className="text-xs text-subtle">Add</span>
          {ADDABLE.map(({ type, icon: Icon }) => (
            <Button key={type} type="button" variant="secondary" size="sm" onClick={() => insert(nodes.length, type)}>
              <Icon aria-hidden="true" className="h-3.5 w-3.5" />
              {NODE_LABEL[type]}
            </Button>
          ))}
        </div>
      )}
    </fieldset>
  );
}

function PartCard({ index, count, name, node, onChange, onMove, onRemove }: { index: number; count: number; name: string; node: RichNode; onChange: (next: RichNode) => void; onMove: (to: number) => void; onRemove: () => void }) {
  const issues = useIssueCount(name);
  const partLabel = `${NODE_LABEL[node.type]} ${index + 1}`;
  return (
    <div data-part={index} className={cn("min-w-0 rounded-lg border bg-surface", issues ? "border-danger/50" : "border-line")}>
      <div className="flex items-center gap-1 border-b border-line py-1 pr-1 pl-3">
        <span className="text-xs font-semibold tracking-wide text-subtle uppercase">{NODE_LABEL[node.type]}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted">{nodeTitle(node)}</span>
        {issues > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full bg-danger-bg px-1.5 text-[11px] font-medium text-danger">
            <TriangleAlert aria-hidden="true" className="h-3 w-3" />
            {issues}
          </span>
        )}
        <IconButton icon={ArrowUp} label={`Move ${partLabel} up`} onClick={() => onMove(index - 1)} disabled={index === 0} />
        <IconButton icon={ArrowDown} label={`Move ${partLabel} down`} onClick={() => onMove(index + 1)} disabled={index === count - 1} />
        <IconButton icon={Trash2} tone="danger" label={`Remove ${partLabel}`} onClick={onRemove} />
      </div>
      <div className="space-y-3 p-3">
        <IssueScope prefix={name}>
          <PartForm node={node} label={partLabel} onChange={onChange} />
        </IssueScope>
      </div>
    </div>
  );
}

function PartForm({ node, label, onChange }: { node: RichNode; label: string; onChange: (next: RichNode) => void }) {
  switch (node.type) {
    case "heading":
      return (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <ChoiceField
              label="Size"
              name="level"
              value={node.level}
              onChange={(level) => onChange({ ...node, level })}
              options={[
                { value: 2, label: "Heading" },
                { value: 3, label: "Subheading" },
              ]}
            />
          </div>
          <TextField label="Heading" name="text" value={node.text} onChange={(text) => onChange({ ...node, text })} max={200} required />
          <AnchorField value={node.anchor} onChange={(anchor) => onChange(anchor ? { ...node, anchor } : { type: "heading", level: node.level, text: node.text })} />
        </>
      );
    case "paragraph":
      return <InlineField label={label} name="text" value={node.text} onChange={(text) => onChange({ ...node, text })} rows={4} />;
    case "note":
      return (
        <>
          <ChoiceField
            label="Tone"
            name="tone"
            value={node.tone}
            onChange={(tone) => onChange({ ...node, tone })}
            options={[
              { value: "info", label: "Information" },
              { value: "warning", label: "Warning" },
            ]}
          />
          <InlineField label="Note" name="text" value={node.text} onChange={(text) => onChange({ ...node, text })} rows={2} />
        </>
      );
    case "list":
      return <ListItemsForm node={node} label={label} onChange={onChange} />;
    case "table":
      return <TableForm node={node} label={label} onChange={onChange} />;
  }
}

function ListItemsForm({ node, label, onChange }: { node: Extract<RichNode, { type: "list" }>; label: string; onChange: (next: RichNode) => void }) {
  const items = node.items;
  const set = (next: RichInline[]) => onChange({ ...node, items: next });
  const messages = useIssuesAt("items");
  return (
    <>
      <CheckField label="Numbered list" checked={!!node.ordered} onChange={(ordered) => onChange(ordered ? { ...node, ordered: true } : { type: "list", items: node.items })} />
      {messages.map((m, i) => (
        <p key={i} className="text-xs text-danger">
          {m}
        </p>
      ))}
      <div className="space-y-2">
        {items.map((item, i) => (
          <div key={i} className="flex items-start gap-1">
            <span aria-hidden="true" className="w-5 shrink-0 pt-2 text-right text-xs text-subtle tabular-nums">
              {node.ordered ? `${i + 1}.` : "•"}
            </span>
            <div className="min-w-0 flex-1">
              <InlineField label={`${label}, item ${i + 1}`} name={`items[${i}]`} value={item} onChange={(next) => set(replaceItem(items, i, next))} rows={1} compact />
            </div>
            <div className="flex shrink-0 items-center pt-1">
              <IconButton icon={ArrowUp} label={`Move item ${i + 1} up`} onClick={() => set(moveItem(items, i, i - 1))} disabled={i === 0} />
              <IconButton icon={ArrowDown} label={`Move item ${i + 1} down`} onClick={() => set(moveItem(items, i, i + 1))} disabled={i === items.length - 1} />
              <IconButton icon={X} tone="danger" label={`Remove item ${i + 1}`} onClick={() => set(removeItem(items, i))} />
            </div>
          </div>
        ))}
      </div>
      {items.length < 50 && (
        <Button type="button" variant="ghost" size="sm" onClick={() => set([...items, ""])} className="-ml-2">
          <Plus aria-hidden="true" className="h-4 w-4" />
          Add item
        </Button>
      )}
    </>
  );
}

function TableForm({ node, label, onChange }: { node: Extract<RichNode, { type: "table" }>; label: string; onChange: (next: RichNode) => void }) {
  const columns = node.columns;
  const rows = node.rows.map((row) => columns.map((_, c) => row[c] ?? ""));
  const setColumns = (next: string[]) => {
    // Columns added or removed at the end keep every row the same width.
    const width = next.length;
    onChange({ ...node, columns: next, rows: rows.map((row) => Array.from({ length: width }, (_, c) => row[c] ?? "")) });
  };
  const setRows = (next: RichInline[][]) => onChange({ ...node, rows: next });
  const removeColumn = (c: number) => onChange({ ...node, columns: removeItem(columns, c), rows: rows.map((row) => removeItem(row, c)) });
  return (
    <>
      <LinesField label="Column headings" name="columns" value={columns} onChange={setColumns} max={80} maxItems={8} required itemNoun="column" />
      {columns.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-subtle">
          Remove a column with its cells:
          {columns.map((c, i) => (
            <Button key={i} type="button" variant="ghost" size="sm" onClick={() => removeColumn(i)} className="h-7 text-danger hover:text-danger">
              {c || `Column ${i + 1}`}
            </Button>
          ))}
        </div>
      )}
      <div className="space-y-2">
        <p className="text-[13px] font-medium text-muted">Rows</p>
        {rows.map((row, r) => (
          <div key={r} role="group" aria-label={`${label}, row ${r + 1}`} className="rounded-md border border-line p-2">
            <div className="mb-1 flex items-center gap-1">
              <span className="flex-1 text-xs font-medium text-subtle">Row {r + 1}</span>
              <IconButton icon={ArrowUp} label={`Move row ${r + 1} up`} onClick={() => setRows(moveItem(rows, r, r - 1))} disabled={r === 0} />
              <IconButton icon={ArrowDown} label={`Move row ${r + 1} down`} onClick={() => setRows(moveItem(rows, r, r + 1))} disabled={r === rows.length - 1} />
              <IconButton icon={Trash2} tone="danger" label={`Remove row ${r + 1}`} onClick={() => setRows(removeItem(rows, r))} />
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {row.map((cell, c) => (
                <InlineField key={c} label={columns[c] || `Column ${c + 1}`} name={`rows[${r}][${c}]`} value={cell} onChange={(next) => setRows(replaceItem(rows, r, replaceItem(row, c, next)))} rows={1} compact />
              ))}
            </div>
          </div>
        ))}
        {rows.length < 100 && (
          <Button type="button" variant="ghost" size="sm" onClick={() => setRows([...rows, columns.map(() => "")])} className="-ml-2">
            <Plus aria-hidden="true" className="h-4 w-4" />
            Add row
          </Button>
        )}
      </div>
    </>
  );
}

// ─── A run of words with bold, italic and links ──────────────────────────────────────────────────

/** Wraps the selection (or the word "text") in markers, and hands back the new value and selection. */
function wrapSelection(value: string, start: number, end: number, before: string, after: string, fallback: string) {
  const selected = value.slice(start, end) || fallback;
  const next = `${value.slice(0, start)}${before}${selected}${after}${value.slice(end)}`;
  return { next, from: start + before.length, to: start + before.length + selected.length };
}

export function InlineField({ label, name, value, onChange, rows = 3, compact = false }: { label: string; name: string; value: RichInline | undefined; onChange: (next: RichInline) => void; rows?: number; compact?: boolean }) {
  const id = useId();
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const messages = useIssuesAt(name);
  const nested = useIssueCount(name) - messages.length;
  const incoming = value ?? "";
  // The words as typed, kept here: the stored runs are read from them, and only a change from outside
  // (undo, restore, a reorder) rewrites the box.
  const [text, setText] = useState(() => serializeInline(incoming));
  const [seen, setSeen] = useState<RichInline>(incoming);
  if (incoming !== seen) {
    setSeen(incoming);
    if (stableJson(incoming) !== stableJson(parseInline(text))) setText(serializeInline(incoming));
  }
  const [linking, setLinking] = useState<{ from: number; to: number; href: string } | null>(null);

  const commit = (next: string) => {
    const parsed = parseInline(next);
    setText(next);
    setSeen(parsed);
    onChange(parsed);
  };

  const applyWrap = (before: string, after: string, fallback: string) => {
    const el = areaRef.current;
    if (!el) return;
    const { next, from, to } = wrapSelection(text, el.selectionStart, el.selectionEnd, before, after, fallback);
    commit(next);
    window.requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(from, to);
    });
  };

  const startLink = () => {
    const el = areaRef.current;
    if (!el) return;
    setLinking({ from: el.selectionStart, to: el.selectionEnd, href: "" });
  };

  const finishLink = () => {
    if (!linking) return;
    const href = linking.href.trim();
    if (!href || !isAllowedHref(href)) return;
    const { next } = wrapSelection(text, linking.from, linking.to, "[", `](${href.replace(/\)/g, "%29")})`, "words");
    commit(next);
    setLinking(null);
    window.requestAnimationFrame(() => areaRef.current?.focus());
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const key = e.key.toLowerCase();
    if (key === "b") {
      e.preventDefault();
      applyWrap("**", "**", "bold");
    } else if (key === "i") {
      e.preventDefault();
      applyWrap("*", "*", "italic");
    } else if (key === "k") {
      e.preventDefault();
      startLink();
    }
  };

  const linkBad = !!linking?.href.trim() && !isAllowedHref(linking.href.trim());

  return (
    <div className="min-w-0 space-y-1">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id} className={cn(compact && "sr-only")}>
          {label}
        </Label>
        <div role="toolbar" aria-label={`Format ${label}`} className="ml-auto flex items-center">
          <IconButton icon={Bold} label="Bold (Ctrl+B)" onClick={() => applyWrap("**", "**", "bold")} />
          <IconButton icon={Italic} label="Italic (Ctrl+I)" onClick={() => applyWrap("*", "*", "italic")} />
          <IconButton icon={Link2} label="Link (Ctrl+K)" onClick={startLink} />
        </div>
      </div>
      <Textarea
        ref={areaRef}
        id={id}
        value={text}
        rows={rows}
        onChange={(e) => commit(e.target.value)}
        onKeyDown={onKeyDown}
        aria-invalid={messages.length || nested > 0 ? true : undefined}
        className={cn(compact ? "min-h-9" : "min-h-20", (messages.length > 0 || nested > 0) && "border-danger")}
      />
      {linking && (
        <div className="flex flex-wrap items-end gap-2 rounded-md border border-line bg-surface-sunken p-2">
          <div className="min-w-48 flex-1 space-y-1">
            <Label htmlFor={`${id}-href`}>Link address</Label>
            <Input
              id={`${id}-href`}
              autoFocus
              value={linking.href}
              placeholder="/pricing or https://…"
              onChange={(e) => setLinking({ ...linking, href: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  finishLink();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setLinking(null);
                  areaRef.current?.focus();
                }
              }}
              aria-invalid={linkBad || undefined}
              className="font-mono text-[13px]"
            />
            {linkBad && <p className="text-xs text-danger">A page on this site (/pricing), #anchor, https://… or mailto:…</p>}
          </div>
          <Button type="button" size="sm" onClick={finishLink} disabled={!linking.href.trim() || linkBad}>
            Add link
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setLinking(null)}>
            Cancel
          </Button>
        </div>
      )}
      {messages.map((m, i) => (
        <p key={i} className="text-xs text-danger">
          {m}
        </p>
      ))}
      {nested > 0 && <p className="text-xs text-danger">A link or a run of words here needs attention — check the addresses in [ ](…).</p>}
    </div>
  );
}
