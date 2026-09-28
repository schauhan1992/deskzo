"use client";

import { useCallback, useRef, useState, type RefObject } from "react";
import { cmsGetSettings, cmsPublishSettings, cmsSaveSettingsDraft } from "@/actions/cms/settings";
import { issuesByPath, useCmsAction } from "@/components/cms/common/use-cms-action";
import { useUnsavedGuard } from "@/components/cms/common/use-unsaved-guard";
import { useConsoleNotice } from "@/components/console/kit/notice";
import type { SiteSettings } from "@/components/site/blocks/types";
import type { CmsIssue, SettingsDetail } from "@/lib/cms/types";
import { checkSiteSettings, type ValidationMode } from "@/lib/cms/validate";
import { sameValue, settingsChanges } from "./settings-diff";

/**
 * One settings form's life: the fields being edited (in the form's own shape — lists carry row keys),
 * the saved draft they started from, whether they differ (unsaved), whether the saved draft differs
 * from what the site shows (not live), and the three things that can be done — save the draft,
 * publish, discard — with the conflict when somebody else saved in between.
 *
 * Each form sends only its own fields (`toPartial`): General sends the identity, social, search and
 * not-found fields, Navigation the menus. Publishing puts the whole draft live — the other form's
 * saved changes included — which is why the "what changes" list is worked out over the whole
 * settings, not just this form's part.
 *
 * Checked in the browser first with the server's own rules (src/lib/cms/validate.ts, client-safe),
 * so a missing "%s" is pointed at before a round trip; the server checks again, and adds what only it
 * can know — images missing from the library, or without alt text.
 */
export function useSettingsDraft<F>({
  detail,
  defaults,
  toForm,
  toPartial,
  rootRef,
}: {
  detail: SettingsDetail;
  defaults: SiteSettings;
  toForm: (settings: SiteSettings) => F;
  toPartial: (form: F) => Partial<SiteSettings>;
  /** The form's outer element — where the first field with a problem is looked for. */
  rootRef: RefObject<HTMLDivElement | null>;
}) {
  const { show } = useConsoleNotice();
  const action = useCmsAction<SettingsDetail>();
  const [current, setCurrent] = useState(detail);
  const [form, setForm] = useState<F>(() => toForm(detail.draft));
  /** After a refused save or publish: check live, in that mode, so fixing a field clears its message. */
  const [attempted, setAttempted] = useState<ValidationMode | null>(null);
  /** The server's issues belong to the fields as they were sent; any edit after that retires them. */
  const [serverIssuesFor, setServerIssuesFor] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const lastOp = useRef<"save" | "publish">("save");

  const partial = toPartial(form);
  const partialKey = JSON.stringify(partial);
  const keys = Object.keys(partial) as (keyof SiteSettings)[];
  const dirty = keys.some((k) => !sameValue(partial[k], current.draft[k]));
  const merged = { ...current.draft, ...partial } as SiteSettings;
  const live = current.published ?? defaults;
  const changes = settingsChanges(merged, live);

  // Fresh props (a refresh after this page's own save, or a navigation back here): taken in while
  // nothing is being edited — never over somebody's unsaved typing.
  const [seen, setSeen] = useState(detail);
  if (seen !== detail) {
    setSeen(detail);
    if (!dirty && detail.version !== current.version) {
      setCurrent(detail);
      setForm(toForm(detail.draft));
    }
  }

  useUnsavedGuard(dirty);

  const localIssues: CmsIssue[] = attempted ? (() => {
    const checked = checkSiteSettings(merged, attempted);
    return checked.ok ? [] : checked.issues;
  })() : [];
  const serverIssues = serverIssuesFor === partialKey ? action.issues : [];
  const issues = issuesByPath([...localIssues, ...serverIssues]);

  const focusFirstIssue = useCallback(() => {
    window.requestAnimationFrame(() => {
      const bad = rootRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
      bad?.scrollIntoView({ block: "center", behavior: "smooth" });
      bad?.focus({ preventScroll: true });
    });
  }, [rootRef]);

  const adopt = useCallback(
    (next: SettingsDetail) => {
      setCurrent(next);
      setForm(toForm(next.draft));
      setAttempted(null);
      setServerIssuesFor(null);
    },
    [toForm],
  );

  /** The browser's check before anything is sent: false (and the first problem focused) when it fails. */
  function ready(mode: ValidationMode): boolean {
    const checked = checkSiteSettings(merged, mode);
    if (checked.ok) return true;
    setAttempted(mode);
    focusFirstIssue();
    return false;
  }

  type After = { onDone?: () => void; onRefused?: () => void };

  function run(op: "save" | "publish", force: boolean, after?: After) {
    const mode: ValidationMode = op === "publish" ? "publish" : "draft";
    if (!ready(mode)) {
      after?.onRefused?.();
      return;
    }
    lastOp.current = op;
    const sent = partialKey;
    const work =
      op === "publish"
        ? () => cmsPublishSettings({ settings: partial, version: current.version, force })
        : () => cmsSaveSettingsDraft({ settings: partial, version: current.version, force });
    action.run(work, {
      success: op === "publish" ? "Published — the site shows these settings now." : "Draft saved. It isn't on the site until it's published.",
      onDone: (next) => {
        adopt(next);
        after?.onDone?.();
      },
      onRefused: (refusal) => {
        setAttempted(mode);
        setServerIssuesFor(sent);
        after?.onRefused?.();
        if (refusal.issues.length) focusFirstIssue();
      },
    });
  }

  /** "Load their version": the saved settings as they are now, over whatever was typed here. */
  function reloadTheirs() {
    if (reloading) return;
    setReloading(true);
    cmsGetSettings().then(
      (r) => {
        setReloading(false);
        if (r.ok) {
          adopt(r.data);
          action.reset();
          show("info", `Loaded the settings as ${r.data.updatedBy ?? "somebody else"} saved them.`);
        }
      },
      () => setReloading(false),
    );
  }

  return {
    form,
    setForm,
    /** The saved settings: the draft, what is live, who saved it and when. */
    saved: current,
    dirty,
    /** The saved draft is what the site shows (unsaved edits aside). */
    isLive: !current.changed,
    changes,
    issues,
    pending: action.pending || reloading,
    error: action.error,
    conflict: action.conflict,
    ready,
    save: (after?: After) => run("save", false, after),
    publish: (after?: After) => run("publish", false, after),
    overwrite: () => run(lastOp.current, true),
    reloadTheirs,
    discard: () => {
      setForm(toForm(current.draft));
      setAttempted(null);
      setServerIssuesFor(null);
      action.reset();
    },
    resetError: action.reset,
  };
}

export type SettingsDraft<F> = ReturnType<typeof useSettingsDraft<F>>;
