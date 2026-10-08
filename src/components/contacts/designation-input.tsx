"use client";

import { forwardRef, useEffect, useId, useState, type InputHTMLAttributes } from "react";
import { listDesignationNames } from "@/actions/designation";
import { Input } from "@/components/ui/input";

/**
 * A contact's designation, typed (owner, 8 Oct 2026): the workspace's list is offered as you type, and a
 * name that isn't on it is added to it when the contact is saved (src/lib/contacts/designations.ts) —
 * "search, and if it's not there, create". Renamed, retyped and merged in Settings › Lists.
 *
 * A plain text input with a <datalist>, so it works with react-hook-form's `register` and with a
 * controlled value alike, and every browser's own suggestion list does the searching. The list is
 * fetched once, the first time any of these is on screen.
 */

let cached: Promise<string[]> | null = null;
function names(): Promise<string[]> {
  cached ??= listDesignationNames().catch(() => {
    cached = null;
    return [];
  });
  return cached;
}

export const DesignationInput = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, "list">>(function DesignationInput(props, ref) {
  const listId = useId();
  const [options, setOptions] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    names().then((n) => live && setOptions(n));
    return () => {
      live = false;
    };
  }, []);
  return (
    <>
      <Input ref={ref} list={listId} autoComplete="off" maxLength={80} placeholder="Type to search, or add one" {...props} />
      <datalist id={listId}>
        {options.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
    </>
  );
});
