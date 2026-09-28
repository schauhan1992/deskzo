"use client";

import { useEffect, useId, useState, type DragEvent, type KeyboardEvent } from "react";
import { ArrowDown, ArrowUp, ChevronDown, ChevronsDownUp, ChevronsUpDown, Copy, GripVertical, Lock, Plus, Trash2, TriangleAlert } from "lucide-react";
import type { BlockType, SiteBlock } from "@/components/site/blocks/types";
import { AddBlockDialog } from "@/components/cms/editor/add-block-dialog";
import { BlockForm } from "@/components/cms/editor/block-forms";
import { BLOCK_INFO, blockSummary, newBlock } from "@/components/cms/editor/catalog";
import { cloneBlock, describePath, insertItem, moveItem, type FieldIssue } from "@/components/cms/editor/doc-utils";
import { IssueRoot } from "@/components/cms/editor/editor-context";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";

/**
 * The document's blocks, top to bottom: each a card that folds open into its typed form. Move a block
 * with its arrow buttons (or Alt+↑/↓ on its title), or drag it by the grip; duplicate it; remove it
 * (the editor offers Undo); add a block at the end or between any two.
 */

export type BlockListProps = {
  blocks: SiteBlock[];
  allowed: readonly BlockType[];
  /** The block a built-in form page exists for: it cannot be removed. */
  requiredBlock: BlockType | null;
  issues: Map<string, FieldIssue[]>;
  activeId: string | null;
  openIds: ReadonlySet<string>;
  /** Scrolls the list to a block's card (a click in the preview); a new object each time. */
  reveal: { id: string } | null;
  readOnly: boolean;
  onOpenChange: (id: string, open: boolean) => void;
  onOpenAll: (open: boolean) => void;
  onActivate: (id: string) => void;
  onBlocksChange: (fn: (blocks: SiteBlock[]) => SiteBlock[], key?: string) => void;
  onRemove: (block: SiteBlock, index: number) => void;
};

function focusCard(id: string, action = "toggle") {
  window.requestAnimationFrame(() => {
    const card = document.querySelector<HTMLElement>(`[data-block-card="${id}"]`);
    (card?.querySelector<HTMLElement>(`[data-action="${action}"]:not([disabled])`) ?? card?.querySelector<HTMLElement>("[data-action=toggle]"))?.focus();
  });
}

export function BlockList(props: BlockListProps) {
  const { blocks, allowed, readOnly, onBlocksChange, onOpenChange, onActivate, reveal } = props;
  const [adding, setAdding] = useState<{ at: number } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const hasPageTop = blocks.some((b) => BLOCK_INFO[b.type]?.pageTop);

  // A block picked in the preview: bring its card into view.
  useEffect(() => {
    if (!reveal) return;
    const frame = window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-block-card="${reveal.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [reveal]);

  const add = (type: BlockType) => {
    if (!adding) return;
    const block = newBlock(type);
    onBlocksChange((list) => insertItem(list, adding.at, block));
    setAdding(null);
    onOpenChange(block.id, true);
    onActivate(block.id);
    focusCard(block.id);
  };

  const move = (id: string, delta: number) => {
    const from = blocks.findIndex((b) => b.id === id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= blocks.length) return;
    onBlocksChange((list) => moveItem(list, from, to));
    focusCard(id, delta < 0 ? "up" : "down");
  };

  const duplicate = (block: SiteBlock) => {
    const copy = cloneBlock(block);
    onBlocksChange((list) => {
      const at = list.findIndex((b) => b.id === block.id);
      return insertItem(list, at + 1, copy);
    });
    onOpenChange(copy.id, true);
    onActivate(copy.id);
    focusCard(copy.id);
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    if (!dragId || dropAt === null) return;
    const from = blocks.findIndex((b) => b.id === dragId);
    const to = dropAt > from ? dropAt - 1 : dropAt;
    if (from >= 0 && to !== from) onBlocksChange((list) => moveItem(list, from, to));
    setDragId(null);
    setDropAt(null);
  };

  const whereLabel = adding ? (adding.at >= blocks.length ? "at the end" : adding.at === 0 ? "at the top" : `below “${BLOCK_INFO[blocks[adding.at - 1].type]?.label ?? "block"}”`) : "";
  const allOpen = blocks.length > 0 && blocks.every((b) => props.openIds.has(b.id));

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted">
          {blocks.length} {blocks.length === 1 ? "block" : "blocks"}
          <span className="hidden sm:inline"> · click one in the preview to open it</span>
        </p>
        {blocks.length > 0 && (
          <Button type="button" variant="ghost" size="sm" onClick={() => props.onOpenAll(!allOpen)}>
            {allOpen ? <ChevronsDownUp aria-hidden="true" className="h-4 w-4" /> : <ChevronsUpDown aria-hidden="true" className="h-4 w-4" />}
            {allOpen ? "Fold all" : "Open all"}
          </Button>
        )}
      </div>

      <div onDragOver={(e) => dragId && e.preventDefault()} onDrop={onDrop} className="space-y-1">
        {!readOnly && blocks.length > 0 && <InsertHere onClick={() => setAdding({ at: 0 })} label="Add a block at the top" showLine={dropAt === 0} />}
        {blocks.map((block, index) => (
          <div key={block.id}>
            <BlockCard
              {...props}
              block={block}
              index={index}
              dragging={dragId === block.id}
              onMove={(delta) => move(block.id, delta)}
              onDuplicate={() => duplicate(block)}
              onDragStart={() => setDragId(block.id)}
              onDragEnd={() => {
                setDragId(null);
                setDropAt(null);
              }}
              onDragOverCard={(after) => dragId && setDropAt(after ? index + 1 : index)}
            />
            {!readOnly && <InsertHere onClick={() => setAdding({ at: index + 1 })} label={`Add a block below ${BLOCK_INFO[block.type]?.label ?? "this block"} ${index + 1}`} showLine={dropAt === index + 1} last={index === blocks.length - 1} />}
          </div>
        ))}
      </div>

      {blocks.length === 0 && (
        <div className="rounded-xl border border-dashed border-line-strong px-6 py-10 text-center">
          <p className="text-sm font-medium text-text">Nothing here yet</p>
          <p className="mt-1 text-xs text-muted">Pages are built from blocks — a header, sections, text, forms.</p>
          {!readOnly && (
            <Button type="button" className="mt-4" onClick={() => setAdding({ at: 0 })}>
              <Plus aria-hidden="true" className="h-4 w-4" />
              Add the first block
            </Button>
          )}
        </div>
      )}

      <AddBlockDialog open={!!adding} onClose={() => setAdding(null)} onPick={add} allowed={allowed} hasPageTop={hasPageTop} where={whereLabel} />
    </div>
  );
}

function InsertHere({ onClick, label, showLine, last = false }: { onClick: () => void; label: string; showLine: boolean; last?: boolean }) {
  if (last) {
    return (
      <div className="pt-2">
        <Button type="button" variant="secondary" onClick={onClick} className="w-full border-dashed">
          <Plus aria-hidden="true" className="h-4 w-4" />
          Add block
        </Button>
      </div>
    );
  }
  return (
    <div className="group relative flex h-4 items-center justify-center">
      <span aria-hidden="true" className={cn("absolute inset-x-2 top-1/2 h-0.5 -translate-y-1/2 rounded-full", showLine ? "bg-brand" : "bg-transparent group-hover:bg-line-strong group-focus-within:bg-line-strong")} />
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        title="Add a block here"
        className="relative inline-grid h-5 w-5 place-items-center rounded-full border border-line-strong bg-surface text-subtle opacity-0 shadow-sm transition-opacity group-hover:opacity-100 hover:text-brand focus-visible:opacity-100 [@media(hover:none)]:opacity-70"
      >
        <Plus aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function BlockCard({
  block,
  index,
  blocks,
  requiredBlock,
  issues,
  activeId,
  openIds,
  readOnly,
  dragging,
  onOpenChange,
  onActivate,
  onBlocksChange,
  onRemove,
  onMove,
  onDuplicate,
  onDragStart,
  onDragEnd,
  onDragOverCard,
}: BlockListProps & {
  block: SiteBlock;
  index: number;
  dragging: boolean;
  onMove: (delta: number) => void;
  onDuplicate: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOverCard: (after: boolean) => void;
}) {
  const bodyId = useId();
  const info = BLOCK_INFO[block.type];
  const Icon = info?.icon;
  const open = openIds.has(block.id);
  const active = activeId === block.id;
  const blockIssues = issues.get(block.id) ?? [];
  const locked = requiredBlock === block.type && blocks.filter((b) => b.type === requiredBlock).length === 1;
  const label = `${info?.label ?? block.type} ${index + 1}`;
  const summary = blockSummary(block);

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!e.altKey || readOnly) return;
    if (e.key === "ArrowUp") {
      e.preventDefault();
      onMove(-1);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      onMove(1);
    }
  };

  return (
    <div
      role="group"
      data-block-card={block.id}
      aria-label={label}
      onDragOver={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        onDragOverCard(e.clientY > rect.top + rect.height / 2);
      }}
      className={cn(
        "scroll-mt-32 rounded-xl border bg-surface shadow-sm transition-[border-color,box-shadow,opacity]",
        active ? "border-brand/60 ring-brand" : blockIssues.length ? "border-danger/50" : "border-line",
        dragging && "opacity-50",
      )}
    >
      <div className="flex items-center gap-1 py-1.5 pr-1.5 pl-1">
        {!readOnly && (
          <span
            draggable
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", block.id);
              onDragStart();
            }}
            onDragEnd={onDragEnd}
            title="Drag to move (or use the arrows)"
            aria-hidden="true"
            className="grid h-7 w-5 shrink-0 cursor-grab place-items-center text-subtle hover:text-muted active:cursor-grabbing"
          >
            <GripVertical className="h-4 w-4" />
          </span>
        )}
        <button
          type="button"
          data-action="toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          aria-keyshortcuts={readOnly ? undefined : "Alt+ArrowUp Alt+ArrowDown"}
          onClick={() => {
            onOpenChange(block.id, !open);
            onActivate(block.id);
          }}
          onFocus={() => onActivate(block.id)}
          onKeyDown={onKeyDown}
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-1 text-left"
        >
          <ChevronDown aria-hidden="true" className={cn("h-4 w-4 shrink-0 text-subtle transition-transform", !open && "-rotate-90")} />
          {Icon && (
            <span aria-hidden="true" className={cn("grid h-7 w-7 shrink-0 place-items-center rounded-md border", active ? "border-brand/30 bg-brand-subtle text-brand" : "border-line bg-surface-sunken text-muted")}>
              <Icon className="h-3.5 w-3.5" />
            </span>
          )}
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5 text-sm font-medium text-text">
              {info?.label ?? block.type}
              {locked && <Lock aria-label="Required on this page" className="h-3 w-3 text-subtle" />}
            </span>
            {summary && <span className="block truncate text-xs text-muted">{summary}</span>}
          </span>
          {blockIssues.length > 0 && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-danger-bg px-1.5 py-0.5 text-[11px] font-medium text-danger">
              <TriangleAlert aria-hidden="true" className="h-3 w-3" />
              {blockIssues.length}
              <span className="sr-only"> {blockIssues.length === 1 ? "field needs" : "fields need"} attention</span>
            </span>
          )}
        </button>
        {!readOnly && (
          <div className="flex shrink-0 items-center">
            <IconButton icon={ArrowUp} data-action="up" label={`Move ${label} up`} onClick={() => onMove(-1)} disabled={index === 0} />
            <IconButton icon={ArrowDown} data-action="down" label={`Move ${label} down`} onClick={() => onMove(1)} disabled={index === blocks.length - 1} />
            <IconButton icon={Copy} label={`Duplicate ${label}`} onClick={onDuplicate} />
            <IconButton
              icon={Trash2}
              tone="danger"
              label={locked ? `${label} is what this page is for, so it stays` : `Remove ${label}`}
              onClick={() => onRemove(block, index)}
              disabled={locked}
            />
          </div>
        )}
      </div>
      <div id={bodyId} hidden={!open} className="border-t border-line px-4 py-4">
        {open && (
          <IssueRoot issues={blockIssues}>
            {blockIssues.length > 0 && (
              <div role="status" className="mb-4 rounded-lg border border-danger/30 bg-danger-bg px-3 py-2 text-xs text-danger">
                <p className="font-medium">
                  {blockIssues.length === 1 ? "One field needs" : `${blockIssues.length} fields need`} attention:
                </p>
                <ul className="mt-1 list-disc space-y-0.5 pl-4">
                  {blockIssues.slice(0, 8).map((issue, i) => (
                    <li key={i}>
                      <span className="font-medium">{describePath(issue.path)}:</span> {issue.message}
                    </li>
                  ))}
                  {blockIssues.length > 8 && <li>…and {blockIssues.length - 8} more below.</li>}
                </ul>
              </div>
            )}
            <fieldset disabled={readOnly} className="min-w-0 space-y-4">
              <legend className="sr-only">{label}</legend>
              <BlockForm
                block={block}
                onChange={(next) =>
                  onBlocksChange(
                    (list) => list.map((b) => (b.id === block.id ? next : b)),
                    `block:${block.id}`,
                  )
                }
              />
            </fieldset>
          </IssueRoot>
        )}
      </div>
    </div>
  );
}
