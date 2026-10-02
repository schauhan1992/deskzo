"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Check, Loader2, PartyPopper } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { completeOnboarding, onboardingState, saveCompanyProfile, skipStep, unskipStep, type OnboardingState } from "@/actions/onboarding";
import { createItem } from "@/actions/item";
import { saveHelpLink } from "@/actions/help";
import { OPEN_ONBOARDING_EVENT, autoOpenedKey } from "@/lib/help/onboarding";
import { firstUnfinished, type GettingStartedStep, type StepKey } from "@/lib/help/getting-started";
import { COMPANY_PROFILE_FIELDS, companyProfileIssues, companyProfileProblem, type CompanyProfileField, type CompanyProfileInput, type CompanyProfileIssues } from "@/lib/help/company-profile";
import {
  EMPTY_HELP,
  EMPTY_ITEM,
  helpDraftEmpty,
  helpIssues,
  helpProblem,
  itemDraftEmpty,
  itemIssues,
  itemProblem,
  type HelpDraft,
  type HelpField,
  type ItemDraft,
  type ItemField,
} from "@/lib/help/onboarding-forms";
import { HelpStep, ItemStep, LogoStep, PhotoStep, ProfileStep, TeamStep, TwoFactorStep } from "@/components/onboarding/onboarding-steps";
import { cn } from "@/lib/utils";

/**
 * The Getting Started wizard (owner's request, 1 Oct 2026): a large dialog — the whole screen on a
 * phone — that walks a new person through their steps (src/lib/help/getting-started.ts) until every
 * one is finished, then closes onboarding for good.
 *
 * Mounted once, in the workspace layout, only for somebody still being onboarded and signed in as
 * themselves (src/lib/help/onboarding.ts). It opens by itself once per sign-in — the browser's
 * sessionStorage remembers, so "Finish later" isn't undone by the next page — and from Getting
 * Started's "Continue setup" any time.
 *
 * Every step's form is embedded (see onboarding-steps.tsx), and "Save and continue" moves on only once
 * the server says the step is done or skipped. A required step can't be passed until it is done; an
 * optional one can be skipped, and a skip counts as finished. Drafts live here, and every step stays
 * mounted while the dialog is open, so going back and forth loses nothing.
 *
 * The company's own guides are one of the optional ones: Deskzo's help, videos and What's new are in
 * the rail from the start, so nobody is asked to write help before they can begin.
 */

const SHORT: Record<StepKey, string> = {
  organisation: "Company profile",
  logo: "Logo",
  team: "Your team",
  items: "What you sell",
  helpline: "Your own guides",
  photo: "Your photo",
  "two-factor": "Two-factor sign-in",
};

/** Steps whose form saves when "Save and continue" is pressed; the rest save as they go. */
const FORM_STEPS: readonly StepKey[] = ["organisation", "items", "helpline"];

type Message = { tone: "error" | "info"; text: string } | null;
type Place = StepKey | "done";

/** After `from`, the next step still to do — or the first one before it — or the end. */
function nextPlace(steps: GettingStartedStep[], from: StepKey): Place {
  const at = steps.findIndex((s) => s.key === from);
  const after = steps.slice(at + 1).find((s) => !s.finished);
  return after?.key ?? firstUnfinished(steps)?.key ?? "done";
}

export function OnboardingWizard({
  autoOpen,
  signInKey,
  preview,
}: {
  autoOpen: boolean;
  signInKey: string;
  /** check:onboarding's renders only: open at this step with this state, without asking the server. */
  preview?: { state: OnboardingState; place: StepKey | "done" };
}) {
  const router = useRouter();
  const [open, setOpen] = useState(!!preview);
  const [state, setState] = useState<OnboardingState | null>(preview?.state ?? null);
  const [place, setPlace] = useState<Place | null>(preview?.place ?? null);
  const [message, setMessage] = useState<Message>(null);
  const [busy, startBusy] = useTransition();

  // Drafts: kept while the page is, so closing with "Finish later" and coming back loses nothing.
  const [profile, setProfile] = useState<CompanyProfileInput | null>(preview?.state.profile ?? null);
  const [profileIssues, setProfileIssues] = useState<CompanyProfileIssues>({});
  const [item, setItem] = useState<ItemDraft>(EMPTY_ITEM);
  const [itemErrors, setItemErrors] = useState<Partial<Record<ItemField, string>>>({});
  const [itemsAdded, setItemsAdded] = useState<string[]>([]);
  const [help, setHelp] = useState<HelpDraft>(EMPTY_HELP);
  const [helpErrors, setHelpErrors] = useState<Partial<Record<HelpField, string>>>({});
  const [helpAdded, setHelpAdded] = useState<string[]>([]);

  const [completion, setCompletion] = useState<{ at: "idle" | "saving" | "saved" } | { at: "failed"; error: string }>({ at: "idle" });
  const headings = useRef(new Map<Place, HTMLElement | null>());
  const moved = useRef(false);

  const steps = state?.steps ?? [];
  const index = place && place !== "done" ? steps.findIndex((s) => s.key === place) : -1;
  const current = index >= 0 ? steps[index]! : null;

  /** The last screen closes onboarding — checked again on the server. */
  const finish = useCallback(() => {
    setCompletion({ at: "saving" });
    completeOnboarding().then((r) => setCompletion(r.ok ? { at: "saved" } : { at: "failed", error: r.error }));
  }, []);

  const go = useCallback(
    (to: Place) => {
      moved.current = true;
      setMessage(null);
      setPlace(to);
      if (to === "done") finish();
    },
    [finish],
  );

  /** The server's view of the steps — every move forward waits on it. */
  const reload = useCallback(async (): Promise<OnboardingState | null> => {
    const fresh = await onboardingState();
    if (fresh) {
      setState(fresh);
      setProfile((p) => p ?? fresh.profile);
    }
    return fresh;
  }, []);

  const openWizard = useCallback(() => {
    setOpen(true);
    setMessage(null);
    startBusy(async () => {
      const fresh = await reload();
      // Finished in another tab, or nothing to do here (viewing as somebody): the page catches up instead.
      if (!fresh || !fresh.pending) {
        setOpen(false);
        router.refresh();
        return;
      }
      const start = firstUnfinished(fresh.steps)?.key ?? "done";
      setPlace(start);
      if (start === "done") finish();
    });
  }, [reload, router, finish]);

  // "Continue setup", from Getting Started.
  useEffect(() => {
    const onOpen = () => openWizard();
    window.addEventListener(OPEN_ONBOARDING_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_ONBOARDING_EVENT, onOpen);
  }, [openWizard]);

  // By itself, once per sign-in. Storage that can't be read (a private window) means once per page load instead.
  useEffect(() => {
    if (!autoOpen) return;
    const key = autoOpenedKey(signInKey);
    try {
      if (window.sessionStorage.getItem(key)) return;
    } catch {
      // Opened anyway: a wizard that never opens is worse than one that opens again.
    }
    // Remembered as it opens, not before: a cancelled run (React mounting twice in development) must not use up the once.
    const timer = setTimeout(() => {
      try {
        window.sessionStorage.setItem(key, "1");
      } catch {
        // As above.
      }
      openWizard();
    }, 0);
    return () => clearTimeout(timer);
  }, [autoOpen, signInKey, openWizard]);

  // A move puts focus on the new step's title, so a screen reader hears where it now is.
  useEffect(() => {
    if (!moved.current || !place) return;
    moved.current = false;
    headings.current.get(place)?.focus();
  }, [place]);

  function close() {
    setOpen(false);
    if (completion.at === "saved") {
      router.push("/dashboard");
      router.refresh();
    }
  }

  /** The step's own save, when it has one and something was typed. False when it was refused. */
  async function saveStep(step: GettingStartedStep, fresh: OnboardingState): Promise<boolean> {
    if (step.key === "organisation" && profile) {
      const issues = companyProfileIssues(profile);
      setProfileIssues(issues);
      const first = COMPANY_PROFILE_FIELDS.find((f) => issues[f]);
      if (first) {
        document.getElementById(`onb-${first}`)?.focus();
        setMessage({ tone: "error", text: "Some details need another look — each one says why." });
        return false;
      }
      const unchanged = fresh.profile && COMPANY_PROFILE_FIELDS.every((f) => (fresh.profile![f] ?? "") === (profile[f] ?? ""));
      if (step.done && unchanged) return true;
      const saved = await saveCompanyProfile(profile);
      if (!saved.ok) {
        setProfileIssues(saved.issues ?? {});
        const bad = COMPANY_PROFILE_FIELDS.find((f) => saved.issues?.[f]);
        if (bad) document.getElementById(`onb-${bad}`)?.focus();
        setMessage({ tone: "error", text: saved.error });
        return false;
      }
      return true;
    }
    if (step.key === "items" && !itemDraftEmpty(item)) {
      const issues = itemIssues(item);
      setItemErrors(issues);
      const first = (["name", "sku", "price", "tax"] as const).find((f) => issues[f]);
      if (first) {
        document.getElementById(`onb-item-${first}`)?.focus();
        return false;
      }
      const made = await createItem({
        name: item.name.trim(),
        sku: item.sku.trim(),
        type: item.type,
        sellingPrice: item.price.trim(),
        taxRatePercent: item.tax.trim(),
        hsnCode: "",
        active: true,
        trackInventory: false,
      });
      if (!made.ok) {
        if (/SKU/i.test(made.error)) {
          setItemErrors({ sku: `${made.error} Change the SKU to add this one too.` });
          document.getElementById("onb-item-sku")?.focus();
        } else setMessage({ tone: "error", text: made.error });
        return false;
      }
      setItemsAdded((list) => [...list, item.name.trim()]);
      setItem(EMPTY_ITEM);
      setItemErrors({});
      return true;
    }
    if (step.key === "helpline" && !helpDraftEmpty(help)) {
      const issues = helpIssues(help);
      setHelpErrors(issues);
      const first = (["title", "url"] as const).find((f) => issues[f]);
      if (first) {
        document.getElementById(`onb-help-${first}`)?.focus();
        return false;
      }
      const saved = await saveHelpLink({ kind: help.kind, title: help.title.trim(), url: help.url.trim() });
      if (!saved.ok) {
        setHelpErrors({ url: saved.error });
        document.getElementById("onb-help-url")?.focus();
        return false;
      }
      setHelpAdded((list) => [...list, help.title.trim()]);
      setHelp(EMPTY_HELP);
      setHelpErrors({});
      return true;
    }
    return true;
  }

  function saveAndContinue() {
    if (!current || !state) return;
    const step = current;
    setMessage(null);
    startBusy(async () => {
      if (!(await saveStep(step, state))) return;
      const fresh = await reload();
      if (!fresh) return;
      const now = fresh.steps.find((s) => s.key === step.key);
      if (now && !now.finished) {
        setMessage({
          tone: "error",
          text: now.required
            ? `${now.title} is needed before you can go on — ${now.key === "two-factor" ? "set it up above." : "fill in the details above."}`
            : now.key === "helpline"
              ? "Add a guide of your own, or choose Skip for now — Deskzo's help is already in the rail."
              : `${now.key === "logo" ? "Choose a logo" : now.key === "photo" ? "Add a photo" : now.key === "team" ? "Add somebody" : "Fill this in"}, or choose Skip for now.`,
        });
        return;
      }
      go(nextPlace(fresh.steps, step.key));
    });
  }

  function skip() {
    if (!current) return;
    const step = current;
    startBusy(async () => {
      const r = await skipStep(step.key);
      if (!r.ok) {
        setMessage({ tone: "error", text: r.error });
        return;
      }
      setState((s) => (s ? { ...s, steps: r.data.steps } : s));
      go(nextPlace(r.data.steps, step.key));
    });
  }

  function undoSkip() {
    if (!current) return;
    const step = current;
    startBusy(async () => {
      const r = await unskipStep(step.key);
      if (!r.ok) setMessage({ tone: "error", text: r.error });
      else setState((s) => (s ? { ...s, steps: r.data.steps } : s));
    });
  }

  function back() {
    if (place === "done") {
      setCompletion((c) => (c.at === "failed" ? { at: "idle" } : c));
      go(steps[steps.length - 1]?.key ?? "done");
    } else if (index > 0) go(steps[index - 1]!.key);
  }

  const leaveProfile = (field: CompanyProfileField) => {
    if (!profile) return;
    const problem = companyProfileProblem(field, profile);
    setProfileIssues((all) => ({ ...all, [field]: problem ?? undefined }));
  };
  const changeProfile = (patch: Partial<CompanyProfileInput>) => {
    setProfile((p) => (p ? { ...p, ...patch } : p));
    // A field with an error is checked again as it is fixed; a new error waits until it is left.
    setProfileIssues((all) => {
      const next = { ...all };
      for (const field of Object.keys(patch) as CompanyProfileField[]) if (next[field] && profile) next[field] = companyProfileProblem(field, { ...profile, ...patch }) ?? undefined;
      return next;
    });
  };
  const changeItem = (patch: Partial<ItemDraft>) => {
    const draft = { ...item, ...patch };
    setItem(draft);
    setItemErrors((all) => {
      const next = { ...all };
      for (const field of ["name", "sku", "price", "tax"] as const) if (next[field]) next[field] = itemProblem(field, draft) ?? undefined;
      return next;
    });
  };
  const changeHelp = (patch: Partial<HelpDraft>) => {
    const draft = { ...help, ...patch };
    setHelp(draft);
    setHelpErrors((all) => {
      const next = { ...all };
      for (const field of ["title", "url"] as const) if (next[field]) next[field] = helpProblem(field, draft) ?? undefined;
      return next;
    });
  };
  const refreshQuietly = () => void reload();

  const finishedCount = steps.filter((s) => s.finished).length;
  const hasForm = current ? FORM_STEPS.includes(current.key) : false;
  const formHasInput = current?.key === "organisation" || (current?.key === "items" && !itemDraftEmpty(item)) || (current?.key === "helpline" && !helpDraftEmpty(help));
  const primaryLabel = current && hasForm && (formHasInput || !current.finished) ? "Save and continue" : "Continue";

  return (
    <Dialog open={open} onClose={close} title="Getting started" large fullScreenOnPhone>
      {!state || !place ? (
        <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted" role="status">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading your steps…
        </div>
      ) : (
        <div
          className="flex min-h-full flex-col gap-5 sm:flex-row sm:gap-6"
          // A link out of the wizard (Settings → Profile, Users & access…) goes to that page: the wizard steps aside
          // rather than staying open over it, and "Continue setup" brings it back, re-checked.
          onClickCapture={(e) => {
            if ((e.target as HTMLElement).closest("a[href]")) setOpen(false);
          }}
        >
          {/* The steps, ticked — a list on wide screens, "Step 3 of 7" on a phone. */}
          <nav aria-label="Setup steps" className="shrink-0 sm:w-48">
            <div className="sm:hidden">
              <p className="text-xs font-medium text-muted">{place === "done" ? "All steps finished" : `Step ${index + 1} of ${steps.length}`}</p>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-sunken" aria-hidden="true">
                <div className="h-full rounded-full bg-brand transition-[width] duration-300" style={{ width: `${steps.length ? Math.round((finishedCount / steps.length) * 100) : 100}%` }} />
              </div>
            </div>
            <ol className="hidden space-y-0.5 sm:block">
              {steps.map((s, i) => {
                const here = s.key === place;
                return (
                  <li
                    key={s.key}
                    aria-current={here ? "step" : undefined}
                    className={cn("flex items-center gap-2.5 rounded-base px-2 py-1.5 text-[13px]", here ? "bg-brand-subtle font-medium text-text" : "text-muted")}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "grid h-5 w-5 shrink-0 place-items-center rounded-full border text-[11px] font-semibold",
                        s.done ? "border-success bg-success-bg text-success" : s.skipped ? "border-line-strong border-dashed text-subtle" : here ? "border-brand text-brand" : "border-line-strong text-subtle",
                      )}
                    >
                      {s.done ? <Check className="h-3 w-3" strokeWidth={3} /> : s.skipped ? "–" : i + 1}
                    </span>
                    <span className="min-w-0 truncate">{SHORT[s.key]}</span>
                    <span className="sr-only">{s.done ? " — done" : s.skipped ? " — skipped" : s.required ? " — required" : ""}</span>
                  </li>
                );
              })}
              <li aria-current={place === "done" ? "step" : undefined} className={cn("flex items-center gap-2.5 rounded-base px-2 py-1.5 text-[13px]", place === "done" ? "bg-brand-subtle font-medium text-text" : "text-muted")}>
                <span aria-hidden="true" className="grid h-5 w-5 shrink-0 place-items-center rounded-full border border-line-strong text-[11px] text-subtle">
                  ★
                </span>
                All set
              </li>
            </ol>
          </nav>

          <div className="flex min-w-0 flex-1 flex-col">
            {steps.map((s) => (
              <section key={s.key} hidden={s.key !== place} aria-labelledby={`onb-step-${s.key}`} className="animate-fade-rise">
                <div className="flex flex-wrap items-center gap-2">
                  <h3
                    id={`onb-step-${s.key}`}
                    tabIndex={-1}
                    ref={(el) => {
                      headings.current.set(s.key, el);
                    }}
                    className="text-base font-semibold text-text outline-none"
                  >
                    {s.title}
                  </h3>
                  {s.done ? (
                    <span className="rounded-full bg-success-bg px-2 py-px text-[11px] font-medium text-success">Done</span>
                  ) : s.skipped ? (
                    <span className="rounded-full bg-surface-sunken px-2 py-px text-[11px] font-medium text-muted">Skipped</span>
                  ) : s.required ? (
                    <span className="rounded-full bg-warning-bg px-2 py-px text-[11px] font-medium text-warning">Required</span>
                  ) : (
                    <span className="rounded-full bg-surface-sunken px-2 py-px text-[11px] font-medium text-muted">Optional</span>
                  )}
                </div>
                <p className="mt-1 text-sm text-muted">{s.description}</p>
                {s.skipped && (
                  <p className="mt-2 text-xs text-subtle">
                    You skipped this — it counts as finished, and you can do it any time from {s.where}.{" "}
                    <button type="button" className="font-medium text-brand hover:underline" onClick={undoSkip} disabled={busy}>
                      Do it now instead
                    </button>
                  </p>
                )}
                <div className="mt-4">
                  {s.key === "organisation" && profile && <ProfileStep draft={profile} issues={profileIssues} gstinLocked={state.gstinLocked} onChange={changeProfile} onLeave={leaveProfile} />}
                  {s.key === "logo" && <LogoStep logoDataUrl={state.logoDataUrl} onSaved={refreshQuietly} />}
                  {s.key === "team" && <TeamStep team={state.team} done={s.done} onAdded={refreshQuietly} />}
                  {s.key === "items" && (
                    <ItemStep
                      draft={item}
                      issues={itemErrors}
                      india={state.india}
                      added={itemsAdded}
                      onChange={changeItem}
                      onLeave={(f) => setItemErrors((all) => ({ ...all, [f]: itemProblem(f, item) ?? undefined }))}
                    />
                  )}
                  {s.key === "helpline" && (
                    <HelpStep draft={help} issues={helpErrors} added={helpAdded} onChange={changeHelp} onLeave={(f) => setHelpErrors((all) => ({ ...all, [f]: helpProblem(f, help) ?? undefined }))} />
                  )}
                  {s.key === "photo" && <PhotoStep me={state.me} onSaved={refreshQuietly} />}
                  {s.key === "two-factor" && <TwoFactorStep enabled={state.me.twoFactorEnabled} onEnabled={refreshQuietly} />}
                </div>
              </section>
            ))}

            <section hidden={place !== "done"} aria-labelledby="onb-step-done" className="animate-fade-rise text-center sm:py-6">
              <PartyPopper className="mx-auto h-10 w-10 text-brand" aria-hidden="true" />
              <h3
                id="onb-step-done"
                tabIndex={-1}
                ref={(el) => {
                  headings.current.set("done", el);
                }}
                className="mt-3 text-lg font-semibold text-text outline-none"
              >
                You&apos;re all set
              </h3>
              <p className="mx-auto mt-1 max-w-sm text-sm text-muted">
                {steps.some((s) => s.skipped)
                  ? "Everything's in place. What you skipped is waiting in Settings whenever you want it."
                  : "Everything's in place. Your dashboard is ready."}
              </p>
              <div className="mt-5" role="status">
                {completion.at === "saving" && (
                  <p className="flex items-center justify-center gap-2 text-sm text-muted">
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    Finishing up…
                  </p>
                )}
                {completion.at === "saved" && (
                  <Button type="button" onClick={close}>
                    Go to your dashboard
                  </Button>
                )}
              </div>
              {completion.at === "failed" && (
                <div className="mt-2 space-y-3" role="alert">
                  <p className="text-sm text-danger">{completion.error}</p>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setCompletion({ at: "idle" });
                      startBusy(async () => {
                        const fresh = await reload();
                        if (fresh) go(firstUnfinished(fresh.steps)?.key ?? "done");
                      });
                    }}
                  >
                    Back to the steps
                  </Button>
                </div>
              )}
            </section>

            <div className="mt-4 min-h-5 text-sm" aria-live="polite">
              {message && <p className={message.tone === "error" ? "font-medium text-danger" : "text-muted"}>{message.text}</p>}
            </div>

            {place !== "done" && current && (
              <div className="sticky bottom-0 mt-auto flex flex-wrap items-center gap-2 border-t border-line bg-surface pt-4">
                <Button type="button" variant="ghost" size="sm" onClick={back} disabled={busy || index <= 0}>
                  <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                  Back
                </Button>
                <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
                  <Button type="button" variant="ghost" size="sm" onClick={close} disabled={busy}>
                    Finish later
                  </Button>
                  {current.skippable && !current.done && !current.skipped && (
                    <Button type="button" variant="secondary" size="sm" onClick={skip} disabled={busy}>
                      Skip for now
                    </Button>
                  )}
                  <Button type="button" size="sm" onClick={saveAndContinue} disabled={busy}>
                    {busy ? "Checking…" : primaryLabel}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}
