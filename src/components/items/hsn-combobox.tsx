"use client";

import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { useComboboxKeyboard, useComboboxSearch } from "@/components/ui/use-combobox-keyboard";
import { describeHsnCode, searchHsnCodes, type HsnDescription } from "@/actions/hsn";
import type { HsnOption } from "@/lib/hsn";
import { HSN_PATTERN, normaliseHsn } from "@/lib/items/catalogue-import";
import { cn } from "@/lib/utils";

/**
 * The HSN/SAC field, searching the GST portal's directory as it is typed into.
 *
 * Digits match the start of a code ("8471" offers 8471, 847130, 84713010…), words the description
 * ("software licence", "computer repair"). Picking a row puts its code in the field. A code typed in
 * full and never picked is kept as typed, and the line under the field says what the directory calls
 * it — or that the directory doesn't list it, which is what the save will refuse.
 *
 * The item's type narrows the search: a good is offered HSN codes, a service SAC codes; a subscription
 * or perpetual licence either (src/lib/hsn.ts).
 */
export function HsnCombobox({
  id,
  value,
  onChange,
  itemType,
  placeholder = "Search by code or description — e.g. 8471, software",
  "aria-label": ariaLabel,
  "aria-invalid": ariaInvalid,
  "aria-describedby": ariaDescribedBy,
}: {
  id?: string;
  placeholder?: string;
  /** Where there is no visible label pointing at `id` — the items list's bulk bar. */
  "aria-label"?: string;
  value: string;
  onChange: (code: string) => void;
  itemType?: string;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState(value);
  const [synced, setSynced] = useState(value);
  // The code last picked from the list or set from outside: in the field, it is a choice rather than
  // a search, so tabbing back in doesn't query it again. Typing makes it a search.
  const [picked, setPicked] = useState(value);
  // Kept in step when the form sets the value from outside (a reset), adjusted during render.
  if (value !== synced) {
    setSynced(value);
    setQuery(value);
    setPicked(value);
  }

  const code = normaliseHsn(value);
  const server = useComboboxSearch<HsnOption>({
    search: (q) => searchHsnCodes(q, itemType),
    query: query === picked ? "" : query.trim(),
    isOpen,
  });
  const results = server.options;

  function choose(option: HsnOption) {
    setSynced(option.code);
    setPicked(option.code);
    setQuery(option.code);
    onChange(option.code);
    setIsOpen(false);
  }

  const combobox = useComboboxKeyboard({
    label: "HSN and SAC codes",
    optionCount: results.length,
    isOpen,
    setOpen: setIsOpen,
    onChoose: (index) => {
      const option = results[index];
      if (option) choose(option);
    },
    resetKey: results.map((r) => r.code).join(","),
  });

  return (
    <div className="space-y-1">
      <div className="relative">
        <Input
          id={id}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSynced(e.target.value);
            onChange(e.target.value);
            setIsOpen(true);
          }}
          onFocus={() => setIsOpen(true)}
          onBlur={() => setTimeout(() => setIsOpen(false), 150)}
          placeholder={placeholder}
          autoComplete="off"
          aria-label={ariaLabel}
          aria-invalid={ariaInvalid}
          aria-describedby={ariaDescribedBy}
          className="aria-[invalid=true]:border-danger"
          {...combobox.comboboxProps}
        />
        {isOpen && server.active && (
          <div
            // Keeping mousedown off the document stops the field blurring before a click on a row lands.
            onMouseDown={(e) => e.preventDefault()}
            className="absolute z-20 mt-1 max-h-80 w-full min-w-[22rem] overflow-y-auto rounded-md border border-line bg-surface py-1 shadow-lg"
            {...combobox.listboxProps}
          >
            {results.map((option, index) => (
              <button
                key={option.code}
                type="button"
                onClick={() => choose(option)}
                {...combobox.optionProps(index)}
                className={cn(
                  "flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-sm hover:bg-surface-sunken",
                  combobox.activeIndex === index && "bg-surface-sunken",
                )}
              >
                <span className="flex w-full items-baseline gap-2">
                  <span className="font-mono font-medium text-text tabular-nums">{option.code}</span>
                  <span className="text-xs text-subtle">{option.kind === "SERVICES" ? "SAC" : "HSN"}</span>
                </span>
                <span className="line-clamp-2 text-xs text-muted">{option.description}</span>
                {option.heading && <span className="line-clamp-1 text-xs text-subtle">under {option.heading}</span>}
              </button>
            ))}
            {server.searching && <div className="px-3 py-2 text-sm text-subtle">Searching…</div>}
            {server.failed && <div className="px-3 py-2 text-sm text-danger">{"Couldn't search — try again"}</div>}
            {results.length === 0 && !server.searching && !server.failed && (
              <div className="px-3 py-2 text-sm text-subtle">
                No code matches that. The directory uses the tariff&apos;s words — a laptop is a &ldquo;portable automatic data
                processing machine&rdquo;.
              </div>
            )}
          </div>
        )}
      </div>
      <HsnMeaning code={code} />
    </div>
  );
}

/** What the directory calls the code in the field — or that it doesn't list it. */
function HsnMeaning({ code }: { code: string }) {
  const [answer, setAnswer] = useState<{ for: string; description: HsnDescription } | null>(null);
  const complete = HSN_PATTERN.test(code);

  useEffect(() => {
    if (!complete) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      describeHsnCode(code).then(
        (description) => {
          if (!cancelled) setAnswer({ for: code, description });
        },
        () => {},
      );
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [code, complete]);

  const current = complete && answer?.for === code ? answer.description : null;
  if (!current) return null;
  if (current.status === "found") {
    return (
      <p className="text-xs text-muted">
        <span className="font-medium text-text">{current.option.kind === "SERVICES" ? "SAC" : "HSN"}:</span> {current.option.description}
        {current.option.heading && <span className="text-subtle"> · under {current.option.heading}</span>}
      </p>
    );
  }
  if (current.status === "not-found") {
    return <p className="text-xs text-danger">{code} isn&apos;t in the GST portal&apos;s HSN/SAC directory — search for the right code.</p>;
  }
  return null;
}
