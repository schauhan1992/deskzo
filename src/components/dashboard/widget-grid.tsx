"use client";

import { useState, useTransition, type ReactNode } from "react";
import { GripVertical } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A grid of cards, in the order this person put them.
 *
 * ## Why the page hands over rendered nodes
 *
 * Every widget is built on the server — each one is a database read, and several are scoped by
 * permission. So the page renders them and passes them here as nodes. This component owns only
 * their arrangement, and knows nothing about what any of them contains. That is the reason it can
 * reorder anything without a special case: a card it cannot describe is a card it cannot get wrong.
 *
 * It does not know where the order is saved either. The dashboard keeps its order in the same
 * array as its selection, because there the two are one decision; every other page stores only an
 * order. Passing `onReorder` in means neither of them has to be the special case.
 *
 * ## Dragging from a handle, not from the card
 *
 * Making the whole card draggable is one line shorter and wrong. Every widget is a link, most hold
 * more links inside, and a card that starts a drag on mousedown makes the text inside unselectable
 * and turns a mis-aimed click into a rearrangement. So `draggable` is switched on only while the
 * grip is held, which is also what makes the grip worth showing.
 *
 * The same moves are on the keyboard, because a rearrangement you can only perform with a mouse is
 * one a lot of people simply cannot perform.
 */

export type GridItem = {
  key: string;
  /** What the widget is called, for the handle's accessible name. "recentLeads" is not a name. */
  label: string;
  size: "stat" | "wide";
  node: ReactNode;
};

export function WidgetGrid({
  items,
  onReorder,
}: {
  items: GridItem[];
  /** Persist the new order. Called after the move is already on screen, never awaited. */
  onReorder: (keys: string[]) => Promise<unknown>;
}) {
  const [order, setOrder] = useState(() => items.map((i) => i.key));
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // The page re-renders with a different set when somebody changes their selection in Customize.
  // Deriving during render rather than in an effect keeps the grid from painting the stale order
  // for a frame first — the same pattern the note dialog uses to refill its fields.
  const incoming = items.map((i) => i.key).join("|");
  const [syncedTo, setSyncedTo] = useState(incoming);
  if (incoming !== syncedTo) {
    setSyncedTo(incoming);
    setOrder(items.map((i) => i.key));
  }

  const byKey = new Map(items.map((i) => [i.key, i]));
  const shown = order.filter((k) => byKey.has(k));
  const fromIndex = dragging ? shown.indexOf(dragging) : -1;

  function persist(next: string[]) {
    setOrder(next);
    // Not awaited and not blocking: the arrangement is already on screen, and a card that snapped
    // back while a request was in flight would read as the drag having failed.
    startTransition(async () => {
      await onReorder(next);
    });
  }

  function move(key: string, to: number) {
    const from = shown.indexOf(key);
    const target = Math.max(0, Math.min(shown.length - 1, to));
    if (from === -1 || from === target) return;
    const next = [...shown];
    next.splice(target, 0, ...next.splice(from, 1));
    persist(next);
  }

  function onDrop(targetKey: string) {
    if (!dragging || dragging === targetKey) return;
    move(dragging, shown.indexOf(targetKey));
    setDragging(null);
    setOver(null);
  }

  return (
    <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {shown.map((key, index) => {
        const item = byKey.get(key)!;
        return (
          <div
            key={key}
            draggable={armed === key}
            onDragStart={(e) => {
              setDragging(key);
              e.dataTransfer.effectAllowed = "move";
              // Firefox starts no drag at all without data on the transfer.
              e.dataTransfer.setData("text/plain", key);
            }}
            onDragEnd={() => {
              setDragging(null);
              setOver(null);
              setArmed(null);
            }}
            onDragOver={(e) => {
              if (!dragging) return;
              // Without this the drop never fires — the default is to refuse.
              e.preventDefault();
              if (over !== key) setOver(key);
            }}
            onDragLeave={() => setOver((prev) => (prev === key ? null : prev))}
            onDrop={(e) => {
              e.preventDefault();
              onDrop(key);
            }}
            className={cn(
              "group/widget relative transition-opacity",
              item.size === "wide" && "sm:col-span-2",
              dragging === key && "opacity-40",
              // A line marking where the card will actually land, which is not always the same
              // side as the one the pointer is on: dragging forwards drops *after* the card you
              // are over, backwards drops before it. Drawing it on the left either way would
              // promise a slot the drop does not use.
              over === key && dragging !== key && "before:absolute before:top-0 before:h-full before:w-0.5 before:rounded before:bg-brand",
              over === key && dragging !== key && (fromIndex < index ? "before:-right-2" : "before:-left-2"),
            )}
          >
            <button
              type="button"
              aria-label={`Move ${item.label} — drag, or use the left and right arrow keys`}
              title="Drag to rearrange"
              onMouseDown={() => setArmed(key)}
              onMouseUp={() => setArmed(null)}
              onFocus={() => setArmed(key)}
              onBlur={() => setArmed(null)}
              onKeyDown={(e) => {
                if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
                e.preventDefault();
                move(key, index + (e.key === "ArrowRight" ? 1 : -1));
              }}
              className={cn(
                "absolute right-1.5 top-1.5 z-10 rounded-base p-1 text-subtle opacity-0 transition-opacity",
                "cursor-grab hover:bg-surface-sunken hover:text-muted active:cursor-grabbing",
                "focus-visible:opacity-100 group-hover/widget:opacity-100",
              )}
            >
              <GripVertical className="h-3.5 w-3.5" />
            </button>
            {item.node}
          </div>
        );
      })}
    </div>
  );
}
