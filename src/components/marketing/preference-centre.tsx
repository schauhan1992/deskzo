"use client";

import { useState, useTransition } from "react";
import { Check, MailX } from "lucide-react";
import type { getPreferences } from "@/actions/marketing-public";
import { unsubscribeAll, updatePreferences } from "@/actions/marketing-public";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { MarketingTopic } from "@prisma/client";

type Preferences = NonNullable<Awaited<ReturnType<typeof getPreferences>>>;

/**
 * What a customer sees when they click "manage preferences".
 *
 * Topics rather than a single on/off switch, because the binary version throws away information
 * both sides want: somebody who is tired of the newsletter usually still wants to be told their
 * subscription is about to lapse. Offering the choice turns most would-be unsubscribes into a
 * narrower subscription, and the ones who do leave entirely meant it.
 */
export function PreferenceCentre({ token, preferences }: { token: string; preferences: Preferences }) {
  const [chosen, setChosen] = useState<Set<MarketingTopic>>(
    () => new Set(preferences.topics.filter((t) => t.subscribed).map((t) => t.key)),
  );
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);
  const [gone, setGone] = useState(preferences.unsubscribedFromEverything);
  const [error, setError] = useState<string | null>(null);

  const toggle = (topic: MarketingTopic) => {
    setSaved(false);
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(topic)) next.delete(topic);
      else next.add(topic);
      return next;
    });
  };

  if (gone) {
    return (
      <Card className="mx-auto max-w-lg">
        <CardContent className="space-y-3 py-12 text-center">
          <MailX className="mx-auto h-8 w-8 text-subtle" aria-hidden />
          <h1 className="text-lg font-semibold text-text">You&apos;re unsubscribed.</h1>
          <p className="text-sm text-muted">
            {preferences.ourName} won&apos;t send you marketing again. Anything to do with your account — an invoice,
            a renewal you asked about, a service notice — still reaches you.
          </p>
          <Button
            variant="secondary"
            onClick={() => {
              setGone(false);
              setChosen(new Set());
            }}
          >
            Choose what to receive instead
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="mx-auto max-w-lg">
      <CardContent className="space-y-6 py-6">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold text-text">
            {preferences.firstName ? `${preferences.firstName}, what would you like to hear about?` : "What would you like to hear about?"}
          </h1>
          <p className="text-sm text-muted">
            From {preferences.ourName}
            {preferences.email && <> to {preferences.email}</>}. Change this whenever you like — this link keeps
            working.
          </p>
        </div>

        <div className="space-y-2">
          {preferences.topics.map((topic) => {
            const on = chosen.has(topic.key);
            return (
              <label
                key={topic.key}
                className="flex cursor-pointer items-start gap-3 rounded-lg border border-line px-3 py-2.5 hover:bg-surface-sunken"
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => toggle(topic.key)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-brand"
                />
                <span>
                  <span className="block text-sm font-medium text-text">{topic.label}</span>
                  <span className="block text-xs text-muted">{topic.blurb}</span>
                </span>
              </label>
            );
          })}
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}

        <div className="flex flex-wrap items-center gap-3">
          <Button
            disabled={pending}
            onClick={() => {
              setError(null);
              startTransition(async () => {
                const result = await updatePreferences({ token, topics: [...chosen] });
                if (!result.ok) {
                  setError(result.error);
                  return;
                }
                setSaved(true);
              });
            }}
          >
            {pending ? "Saving…" : "Save my preferences"}
          </Button>
          {saved && (
            <span className="flex items-center gap-1 text-xs text-success">
              <Check className="h-3.5 w-3.5" />
              Saved.
            </span>
          )}
        </div>

        <div className="border-t border-line pt-4">
          <button
            type="button"
            className="text-xs text-muted underline hover:text-text"
            disabled={pending}
            onClick={() => {
              setError(null);
              startTransition(async () => {
                const result = await unsubscribeAll(token);
                if (!result.ok) {
                  setError(result.error);
                  return;
                }
                setGone(true);
              });
            }}
          >
            Or unsubscribe from everything
          </button>
          {preferences.postalAddress && (
            <p className="mt-3 whitespace-pre-line text-[11px] text-subtle">{preferences.postalAddress}</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
