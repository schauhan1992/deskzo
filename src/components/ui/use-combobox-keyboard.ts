"use client";

import { useEffect, useEffectEvent, useId, useRef, useState } from "react";

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
 *
 * `autoHighlightFirst` is for a form where the picked value is mandatory and Enter is the habit —
 * the order punching screen. Without it, typing a name and pressing Enter submits the form with the
 * name typed but nothing picked, because typing clears the value and lands on no row. With it, the
 * first row is highlighted whenever the list is showing rows and nothing else is, so Enter takes
 * the top match; and Enter while the list is open never reaches the form, even with no rows to take
 * (still searching, nothing found). Off by default: everywhere else Enter keeps its old meaning.
 */
export function useComboboxKeyboard({
  label,
  optionCount,
  isOpen,
  setOpen,
  onChoose,
  resetKey,
  autoHighlightFirst = false,
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
  /** Highlight the first row when nothing is, and keep Enter from submitting while the list is open. */
  autoHighlightFirst?: boolean;
}) {
  const listboxId = useId();
  /** Where the arrows put the highlight; -1 until the user aims. */
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

  // The highlight actually shown. Derived rather than stored: the reset above already drops the
  // aimed-at row whenever the rows change, so "the first row once results change" falls out of it
  // with no effect and no second state to keep in step — and the moment a new answer lands, its top
  // row is the one Enter takes.
  const aimed = activeIndex >= 0 && activeIndex < optionCount;
  const highlighted = aimed ? activeIndex : autoHighlightFirst && isOpen && optionCount > 0 ? 0 : -1;

  const activeOptionId = highlighted >= 0 ? optionId(highlighted) : undefined;

  // A highlight below the fold is not a highlight. `block: "nearest"` scrolls the panel just enough
  // to show the row and leaves the page alone when the row is already visible.
  //
  // Looked up by id rather than through a ref into the panel: two of the four callers portal their
  // panel into `document.body`, so there is no one container element that works for all of them.
  // `getElementById` also takes the id verbatim, where `querySelector` would need it escaped —
  // `useId` returns ids containing punctuation that is not valid in a CSS selector.
  useEffect(() => {
    if (!isOpen || highlighted < 0) return;
    document.getElementById(`${listboxId}option-${highlighted}`)?.scrollIntoView({ block: "nearest" });
  }, [isOpen, highlighted, listboxId]);

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
          // deliberately lands on nothing, so Enter still submits the form until you choose to aim
          // (or, with `autoHighlightFirst`, lands on the first row).
          setActiveIndex(optionCount === 0 ? -1 : isDown ? 0 : optionCount - 1);
          return;
        }
        if (optionCount === 0) return;
        setActiveIndex((current) => {
          // The automatic highlight on the first row counts as where the arrows start, so the first
          // ArrowDown moves to row 2 rather than "arriving" on the row that already looks chosen.
          const from = current < 0 && autoHighlightFirst ? 0 : current;
          return isDown
            ? (from + 1) % optionCount
            : from <= 0
              ? optionCount - 1
              : from - 1;
        });
        return;
      }
      case "Home":
      case "End": {
        // Only once the user is navigating the list. While they are still typing, Home and End are
        // how you get to the start and end of your own query — and since the list opens on focus
        // and stays open, taking those keys unconditionally would mean this field is the one place
        // in the app where you cannot jump the caret. The automatic first-row highlight is not
        // navigating, which is why this reads `activeIndex` and not `highlighted`.
        if (!isOpen || activeIndex < 0 || optionCount === 0) return;
        event.preventDefault();
        setActiveIndex(event.key === "Home" ? 0 : optionCount - 1);
        return;
      }
      case "Enter": {
        if (!isOpen) return;
        if (highlighted < 0) {
          // With nothing highlighted, Enter is left alone to submit the form, as it does today —
          // unless the caller asked for the first row to be taken. Then an open list with no row to
          // take (still searching, nothing found) holds Enter back too, or a name that is typed but
          // not picked would submit the form exactly as if the field were filled.
          if (autoHighlightFirst) event.preventDefault();
          return;
        }
        event.preventDefault();
        onChoose(highlighted);
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
    /** The row to draw highlighted: the one aimed at, or the automatic first row. */
    activeIndex: highlighted,
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
      "aria-selected": index === highlighted,
      tabIndex: -1,
    }),
  };
}

/** Under this, a search would match half the book; the picker's own list answers instead. */
const SEARCH_MIN_LENGTH = 2;

/** Long enough that a name typed at speed sends one request, short enough to feel immediate. */
const SEARCH_DEBOUNCE_MS = 200;

/**
 * The search half of a combobox, for a picker whose full list is too long to send to the browser.
 *
 * The picker goes on filtering its own list for a query under two characters and asks the server
 * once the query is longer. Three things here are deliberate:
 *
 *   · debounced, so "sharma" typed at speed is one request rather than six;
 *   · the newest request wins — an answer for "sha" that turns up after the one for "sharma" is
 *     dropped, or the list would show the older, wider matches under the narrower query;
 *   · an answer is kept with the query it answers and shown only for that query. Between a
 *     keystroke and its answer the picker says "Searching…" rather than leaving the previous rows up,
 *     because with `autoHighlightFirst` Enter would take the top one of those.
 *
 * It searches only while the list is open, so picking a row — which puts that row's name in the
 * field and closes the list — does not send the name off as a fresh search.
 */
export function useComboboxSearch<T>({
  search,
  query,
  isOpen,
}: {
  /** The server lookup. Without one the hook does nothing and `active` stays false. */
  search: ((query: string) => Promise<T[]>) | undefined;
  /** The text in the field, already trimmed. */
  query: string;
  isOpen: boolean;
}) {
  const [answer, setAnswer] = useState<{ for: string; options: T[]; failed: boolean } | null>(null);
  /** Numbers the requests; only the newest one's answer is kept. */
  const latest = useRef(0);
  const active = Boolean(search) && query.length >= SEARCH_MIN_LENGTH;

  // Reads `search` when the timer fires rather than when it was set, so a caller that passes a new
  // arrow function on every render neither restarts the debounce each time nor runs a stale lookup.
  const run = useEffectEvent((text: string, request: number) => {
    if (!search) return;
    // Started inside the chain so a lookup that throws, rather than rejects, lands in the same place.
    Promise.resolve()
      .then(() => search(text))
      .then(
        (options) => {
          if (request === latest.current) setAnswer({ for: text, options, failed: false });
        },
        () => {
          if (request === latest.current) setAnswer({ for: text, options: [], failed: true });
        },
      );
  });

  useEffect(() => {
    if (!active || !isOpen) return;
    const request = ++latest.current;
    const timer = window.setTimeout(() => run(query, request), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [active, isOpen, query]);

  const current = active && answer?.for === query ? answer : null;
  return {
    /** The server answers for this query, not the picker's own list. */
    active,
    /** Waiting on the debounce or on the server. */
    searching: active && !current,
    /** The lookup failed; the picker says so rather than "no matches". */
    failed: current?.failed ?? false,
    options: current?.options ?? [],
  };
}
