"use client";

import { useEffect, useId, useState } from "react";

/**
 * The keyboard half of a combobox, for the four type-to-search pickers that already share a shape.
 *
 * All four were built the same way — a text field with a floating list of clickable rows — and all
 * four were mouse-only. You could type a query and then had no way to take any of the answers: no
 * arrows, no Enter, no Escape, and nothing announced, because a list of buttons is not a listbox.
 * On a form where the company is mandatory that is a form that cannot be completed without a mouse.
 *
 * This implements the WAI-ARIA combobox pattern (list autocomplete, manual selection):
 *
 *   · the field is the combobox, owning `aria-expanded`, `aria-controls` and `aria-activedescendant`;
 *   · the panel's rows are a `listbox` of `option`s, each with a stable id and `aria-selected`;
 *   · arrows move the highlight, Enter takes it, Escape dismisses, Tab leaves without taking.
 *
 * **Focus never leaves the text field.** This is the part that looks wrong and is not, and the part
 * a later reader will be tempted to "simplify". The obvious implementation of "arrow down highlights
 * the next row" is to call `.focus()` on that row — and that breaks the widget, because a field you
 * are not focused on is a field you cannot go on typing into: the next keystroke lands on the row,
 * not in the query. `aria-activedescendant` exists precisely for this. It tells a screen reader
 * "the user is on this option" while the operating system's focus, and therefore the keyboard,
 * stays on the field. The highlight is ours to draw; the focus ring stays where it is.
 *
 * Nothing here decides *what* an option is. The caller passes how many rows there are and what
 * choosing row `n` means, so a picker whose list ends in a "create new" row can count that row as
 * the last option and reach it with the same arrow keys as the rest.
 */
export function useComboboxKeyboard({
  label,
  optionCount,
  isOpen,
  setOpen,
  onChoose,
  resetKey,
}: {
  /** Names the listbox itself, e.g. "Companies" — the field is named separately by its own label. */
  label: string;
  /** Rows the arrows can reach, including any trailing action row. */
  optionCount: number;
  isOpen: boolean;
  setOpen: (open: boolean) => void;
  /** Take row `index`. Called by Enter; the rows' own click handlers are left alone. */
  onChoose: (index: number) => void;
  /** Changes whenever the result rows do — typically the query. Drops a stale highlight. */
  resetKey: string;
}) {
  const listboxId = useId();
  const [activeIndex, setActiveIndex] = useState(-1);
  const [lastResetKey, setLastResetKey] = useState(resetKey);
  const [wasOpen, setWasOpen] = useState(isOpen);

  const optionId = (index: number) => `${listboxId}option-${index}`;

  // Adjusted during render rather than in an effect, matching how these components already keep
  // their query text in step with `value` — an effect would highlight row 2 of the old results for
  // one painted frame before correcting itself.
  if (resetKey !== lastResetKey) {
    // The list under the cursor just changed, so row 2 is a different company than it was a
    // keystroke ago. Keeping the index would mean Enter picks whatever slid into that position.
    setLastResetKey(resetKey);
    setActiveIndex(-1);
  }
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (!isOpen) setActiveIndex(-1);
  }
  // A shrinking list can strand the highlight past the end of it.
  if (activeIndex >= optionCount) setActiveIndex(-1);

  const activeOptionId = activeIndex >= 0 && activeIndex < optionCount ? optionId(activeIndex) : undefined;

  // A highlight below the fold is not a highlight. `block: "nearest"` scrolls the panel just enough
  // to show the row and leaves the page alone when the row is already visible.
  //
  // Looked up by id rather than through a ref into the panel: two of the four callers portal their
  // panel into `document.body`, so there is no one container element that works for all of them.
  // `getElementById` also takes the id verbatim, where `querySelector` would need it escaped —
  // `useId` returns ids containing punctuation that is not valid in a CSS selector.
  useEffect(() => {
    if (!isOpen || activeIndex < 0) return;
    document.getElementById(`${listboxId}option-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [isOpen, activeIndex, listboxId]);

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        const isDown = event.key === "ArrowDown";
        // Without this the caret jumps to the far end of the query text on every arrow press.
        event.preventDefault();
        if (!isOpen) {
          setOpen(true);
          // Opening with the arrows lands on an end of the list; opening by typing or clicking
          // deliberately lands on nothing, so Enter still submits the form until you choose to aim.
          setActiveIndex(optionCount === 0 ? -1 : isDown ? 0 : optionCount - 1);
          return;
        }
        if (optionCount === 0) return;
        setActiveIndex((current) =>
          isDown
            ? (current + 1) % optionCount
            : current <= 0
              ? optionCount - 1
              : current - 1,
        );
        return;
      }
      case "Home":
      case "End": {
        // Only once the user is navigating the list. While they are still typing, Home and End are
        // how you get to the start and end of your own query — and since the list opens on focus
        // and stays open, taking those keys unconditionally would mean this field is the one place
        // in the app where you cannot jump the caret.
        if (!isOpen || activeIndex < 0 || optionCount === 0) return;
        event.preventDefault();
        setActiveIndex(event.key === "Home" ? 0 : optionCount - 1);
        return;
      }
      case "Enter": {
        // With nothing highlighted, Enter is left alone to submit the form, as it does today.
        if (!isOpen || activeIndex < 0 || activeIndex >= optionCount) return;
        event.preventDefault();
        onChoose(activeIndex);
        return;
      }
      case "Escape": {
        if (!isOpen) return;
        event.preventDefault();
        setOpen(false);
        setActiveIndex(-1);
        // No `.focus()` call: focus never left the field, so there is nothing to return.
        return;
      }
      case "Tab": {
        // Deliberately not prevented — Tab means "I am done here", and it must not select.
        setOpen(false);
        setActiveIndex(-1);
        return;
      }
    }
  }

  return {
    activeIndex,
    /** Spread onto the text field. */
    comboboxProps: {
      role: "combobox" as const,
      "aria-expanded": isOpen,
      "aria-controls": listboxId,
      "aria-autocomplete": "list" as const,
      "aria-activedescendant": activeOptionId,
      onKeyDown: handleKeyDown,
    },
    /** Spread onto the element that wraps the option rows, and nothing else. */
    listboxProps: {
      id: listboxId,
      role: "listbox" as const,
      "aria-label": label,
    },
    /**
     * Spread onto row `index`. The rows stay buttons and keep their own `onClick`, so the mouse
     * path is untouched; `role="option"` replaces what a screen reader would otherwise announce,
     * and `tabIndex={-1}` keeps them out of the tab order, where the pattern says the field is the
     * single stop.
     */
    optionProps: (index: number) => ({
      id: optionId(index),
      role: "option" as const,
      "aria-selected": index === activeIndex,
      tabIndex: -1,
    }),
  };
}
