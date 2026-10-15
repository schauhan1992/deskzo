"use client";

import { useMemo, useState, useTransition } from "react";
import { saveWordFilter } from "@/actions/word-filter";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { compileWordFilter } from "@/lib/word-filter/match";
import { PRESET_ENGLISH, PRESET_HINDI, PRESET_HINGLISH, PRESET_WORDS } from "@/lib/word-filter/preset";

type Area = "CHAT" | "TICKETS";
type Settings = { enabled: boolean; usePreset: boolean; words: string[]; allowed: string[] };

const lines = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean);

/**
 * One area's word filter (src/lib/word-filter): on or off, Deskzo's preset, the workspace's own words,
 * and preset words let through — with a box to try a message against what is on screen, before saving.
 */
export function WordFilterForm({ area, initial }: { area: Area; initial: Settings }) {
  const [enabled, setEnabled] = useState(initial.enabled);
  const [usePreset, setUsePreset] = useState(initial.usePreset);
  const [words, setWords] = useState(initial.words.join("\n"));
  const [allowed, setAllowed] = useState(initial.allowed.join("\n"));
  const [sample, setSample] = useState("");
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [pending, start] = useTransition();
  const where = area === "CHAT" ? "chat" : "tickets";

  // What is on screen, saved or not — the same matching the server does.
  const filter = useMemo(() => compileWordFilter([...(usePreset ? PRESET_WORDS : []), ...lines(words)], lines(allowed)), [usePreset, words, allowed]);
  const caught = sample.trim() ? filter.find(sample) : [];

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const res = await saveWordFilter(area, { enabled, usePreset, words: lines(words), allowed: lines(allowed) });
          if (res.ok) {
            setWords(res.data.words.join("\n"));
            setAllowed(res.data.allowed.join("\n"));
          }
          setMessage(res.ok ? { tone: "ok", text: "Saved." } : { tone: "error", text: res.error });
        });
      }}
    >
      <label className="flex items-start gap-2.5">
        <input type="checkbox" className="mt-0.5 h-4 w-4" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} disabled={pending} />
        <span>
          <span className="block text-sm font-medium text-text">Keep these words out of {where}</span>
          <span className="block text-xs text-muted">
            {area === "CHAT"
              ? "A message (or a group's name) with one of them isn't sent. Only the sender is told which words to change; nothing is recorded."
              : "A ticket, a comment or an email reply your people write with one of them isn't saved, and they're told which words to change. A customer's email still reaches its ticket, with the words shown as stars."}
          </span>
        </span>
      </label>

      <div className="space-y-2">
        <label className="flex items-start gap-2.5">
          <input type="checkbox" className="mt-0.5 h-4 w-4" checked={usePreset} onChange={(e) => setUsePreset(e.target.checked)} disabled={pending} />
          <span>
            <span className="block text-sm text-text">Use Deskzo&apos;s preset of abusive words</span>
            <span className="block text-xs text-muted">
              English, Hindi and Hinglish — {PRESET_WORDS.length} words and spellings, each caught however it&apos;s disguised (f*ck, sh1t, f.u.c.k).
            </span>
          </span>
        </label>
        <details className="ml-6 text-xs text-muted">
          <summary className="cursor-pointer hover:text-text">See the preset&apos;s words</summary>
          <div className="mt-2 space-y-2">
            {[
              ["English", PRESET_ENGLISH],
              ["Hindi", PRESET_HINDI],
              ["Hinglish", PRESET_HINGLISH],
            ].map(([label, list]) => (
              <p key={label as string} className="break-words">
                <span className="font-medium text-text">{label as string}:</span> {(list as readonly string[]).join(", ")}
              </p>
            ))}
            <p>A word ending in * catches its endings too — fuck* catches fucking.</p>
          </div>
        </details>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`words-${area}`}>Your own words</Label>
          <Textarea
            id={`words-${area}`}
            rows={6}
            value={words}
            onChange={(e) => setWords(e.target.value)}
            placeholder={"One a line — a word or a short phrase\nEnd a word with * to catch its endings"}
            disabled={pending}
          />
          <p className="text-xs text-muted">Matched as whole words, whatever the case: &quot;ass&quot; never stops &quot;class&quot;.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`allowed-${area}`}>Let these preset words through</Label>
          <Textarea
            id={`allowed-${area}`}
            rows={6}
            value={allowed}
            onChange={(e) => setAllowed(e.target.value)}
            placeholder="One a line — a name or a word your company uses that happens to be in the preset"
            disabled={pending}
          />
        </div>
      </div>

      <div className="space-y-1.5 rounded-base border border-line bg-surface-sunken p-3">
        <Label htmlFor={`try-${area}`}>Try a message</Label>
        <Input id={`try-${area}`} value={sample} onChange={(e) => setSample(e.target.value)} placeholder="Type something to see what the filter would do" />
        {sample.trim() && (
          <p className={`text-xs ${caught.length ? "text-danger" : "text-success"}`}>
            {caught.length
              ? `Would be refused${enabled ? "" : " once the filter is on"}: ${caught.map((w) => `"${w}"`).join(", ")}.${
                  area === "TICKETS" ? ` From a customer it would read: ${filter.mask(sample)}` : ""
                }`
              : "Would go through."}
          </p>
        )}
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
        {message && <span className={message.tone === "ok" ? "text-sm text-success" : "text-sm text-danger"}>{message.text}</span>}
      </div>
    </form>
  );
}
