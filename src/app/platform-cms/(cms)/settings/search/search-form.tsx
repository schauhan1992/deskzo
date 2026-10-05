"use client";

import { useId, useState, type ReactNode } from "react";
import { Bot, ExternalLink, EyeOff, FileText, Globe, LoaderCircle, Map as MapIcon, Search } from "lucide-react";
import { cmsSaveSearchPolicy } from "@/actions/cms/settings";
import { Banner } from "@/components/console/kit/banner";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { ImpactList } from "@/components/console/kit/impact";
import { Panel } from "@/components/console/kit/panel";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { TextAreaField } from "@/components/cms/common/fields";
import { useCmsAction } from "@/components/cms/common/use-cms-action";
import { CheckField } from "@/components/cms/editor/fields";
import { Button } from "@/components/ui/button";
import { LLMS_SUMMARY_MAX, type SearchPolicy, type SearchPolicyDetail } from "@/lib/cms/types";
import { cn } from "@/lib/utils";

const VISIBILITY = [
  {
    hide: false,
    title: "Visible in search",
    body: "Search engines may list every page, except any kept out one by one. The sitemap lists them.",
    icon: Globe,
  },
  {
    hide: true,
    title: "Hidden from search",
    body: "Every page asks search engines not to list it. The sitemap and llms.txt are empty, and no AI crawler is let in. For a site that isn't ready yet.",
    icon: EyeOff,
  },
] as const;

const same = (a: SearchPolicy, b: SearchPolicy) => (Object.keys(a) as (keyof SearchPolicy)[]).every((k) => a[k] === b[k]);

/**
 * The Search & AI settings as one form with one Save. Hiding the whole site asks first, with what it
 * changes; everything else saves as it is. The policy in force is the saved one — the server's, after
 * every save (the page re-renders).
 */
export function SearchSettingsForm({ detail, fallbackSummary }: { detail: SearchPolicyDetail; fallbackSummary: string }) {
  const saved = detail.policy;
  const [draft, setDraft] = useState<SearchPolicy>(saved);
  const [asking, setAsking] = useState(false);
  const action = useCmsAction<SearchPolicyDetail>();
  const name = useId();
  const set = <K extends keyof SearchPolicy>(key: K, value: SearchPolicy[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const changed = !same(draft, saved);
  const hiding = draft.hideSite && !saved.hideSite;
  const hiddenNow = draft.hideSite || detail.effective.forcedHidden;
  const origin = detail.siteOrigin;

  function save() {
    action.run(() => cmsSaveSearchPolicy({ ...draft, llmsSummary: draft.llmsSummary.trim() }), {
      success: "Saved — the site follows it now.",
      onDone: (next) => {
        setDraft(next.policy);
        setAsking(false);
      },
    });
  }

  function submit() {
    if (!changed || action.pending) return;
    if (hiding) {
      action.reset();
      setAsking(true);
      return;
    }
    save();
  }

  return (
    <div className="grid items-start gap-6 lg:grid-cols-3">
      <form
        className="min-w-0 space-y-6 lg:col-span-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {detail.effective.forcedHidden && (
          <Banner tone="warning" title="This is a staging installation">
            Its public site is always hidden from search, whatever is chosen here (PLATFORM_ENV=staging). The choices below apply on production.
          </Banner>
        )}

        <Panel title="Search engines" description="Whether Google, Bing and the rest may list the website's pages.">
          <fieldset>
            <legend className="sr-only">Search engines</legend>
            <div className="grid gap-2 md:grid-cols-2">
              {VISIBILITY.map((choice) => {
                const checked = draft.hideSite === choice.hide;
                const Icon = choice.icon;
                return (
                  <label
                    key={choice.title}
                    className={cn(
                      "flex cursor-pointer items-start gap-3 rounded-lg border px-3.5 py-3 transition-colors",
                      checked ? "border-brand bg-brand-subtle" : "border-line hover:bg-surface-sunken",
                      action.pending && "cursor-wait",
                    )}
                  >
                    <input
                      type="radio"
                      name={name}
                      checked={checked}
                      disabled={action.pending}
                      onChange={() => set("hideSite", choice.hide)}
                      className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--brand)]"
                    />
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5 text-sm font-medium text-text">
                        <Icon aria-hidden="true" className={cn("h-4 w-4", choice.hide ? "text-warning" : "text-success")} />
                        {choice.title}
                        {saved.hideSite === choice.hide && <span className="text-[11px] font-normal text-muted">· in force</span>}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted">{choice.body}</span>
                    </span>
                  </label>
                );
              })}
            </div>
            <p className="mt-3 text-xs text-muted">
              Hidden, search engines may still fetch pages — that is how they read the noindex and drop what they had listed, which can take a few weeks. To keep one page out, use “Keep this page
              out of search engines” in its SEO settings instead.
            </p>
          </fieldset>
        </Panel>

        <Panel title="AI crawlers" description="Which AI crawlers robots.txt lets read the website.">
          <div className="space-y-4">
            <CheckField
              label="Let AI search assistants read the site"
              checked={draft.aiSearch}
              onChange={(v) => set("aiSearch", v)}
              hint="ChatGPT search, Claude, Perplexity and others. They read a page to answer a question with it, and link back to it."
            />
            <CheckField
              label="Let AI training crawlers read the site"
              checked={draft.aiTraining}
              onChange={(v) => set("aiTraining", v)}
              hint="GPTBot, ClaudeBot, Common Crawl, Google-Extended and others gather pages to train models. They don't link back."
            />
            {hiddenNow && <p className="text-xs text-warning">While the site is hidden from search, no AI crawler is let in, whatever is ticked here.</p>}
            <p className="text-xs text-muted">robots.txt is a request: the large crawlers named in it honour it; one that ignores it is not stopped by it.</p>
          </div>
        </Panel>

        <Panel title="llms.txt" description="A short list of the website's pages for AI assistants, in Markdown, at /llms.txt.">
          <div className="space-y-4">
            <CheckField
              label="Publish llms.txt"
              checked={draft.llmsTxt}
              onChange={(v) => set("llmsTxt", v)}
              hint="Built from the published pages and posts, grouped as the header menu groups them, each with its search description."
            />
            <TextAreaField
              label="Summary"
              value={draft.llmsSummary}
              onChange={(v) => set("llmsSummary", v)}
              max={LLMS_SUMMARY_MAX}
              rows={3}
              readOnly={action.pending || !draft.llmsTxt}
              placeholder={fallbackSummary || undefined}
              hint="The line under the site's name. Left empty, the site's search description (Settings › General) is used."
              error={action.issues.find((i) => i.path === "llmsSummary")?.message}
            />
            <p className="text-xs text-muted">
              To leave a page or post out, tick “Leave this page out of llms.txt” in its SEO settings. Anything kept out of search engines is left out anyway.
            </p>
          </div>
        </Panel>

        {action.error && !asking && <Banner tone="danger" title={action.error} />}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted">
            {detail.updatedAt ? (
              <>
                Last changed <RelativeTime at={detail.updatedAt} />
                {detail.updatedBy ? ` by ${detail.updatedBy}` : ""}.
              </>
            ) : (
              "Never changed: the defaults — visible, AI search in, AI training out, llms.txt on."
            )}
          </p>
          <div className="flex gap-2">
            {changed && (
              <Button type="button" variant="secondary" onClick={() => setDraft(saved)} disabled={action.pending}>
                Undo changes
              </Button>
            )}
            <Button type="submit" disabled={!changed} aria-busy={action.pending || undefined} className={action.pending ? "cursor-wait opacity-70" : undefined}>
              {action.pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
              Save
            </Button>
          </div>
        </div>
      </form>

      <Panel title="What crawlers read" description="The website's own files, as they are now.">
        <ul className="space-y-4 text-sm">
          <FileLink icon={<Bot className="h-4 w-4" />} href={`${origin}/robots.txt`} name="robots.txt">
            {detail.effective.hidden
              ? "Search engines may fetch pages (to read their noindex); every AI crawler is refused."
              : `Search engines in; AI search ${saved.aiSearch ? "in" : "out"}; AI training ${saved.aiTraining ? "in" : "out"}.`}
          </FileLink>
          <FileLink icon={<MapIcon className="h-4 w-4" />} href={`${origin}/sitemap.xml`} name="sitemap.xml">
            {detail.effective.hidden ? "Empty while the site is hidden." : "Every published page and post not kept out of search."}
          </FileLink>
          <FileLink icon={<FileText className="h-4 w-4" />} href={`${origin}/llms.txt`} name="llms.txt" off={detail.effective.hidden || !saved.llmsTxt}>
            {detail.effective.hidden ? "Not served while the site is hidden." : saved.llmsTxt ? "The pages and posts not left out of it." : "Switched off: not served."}
          </FileLink>
          <li className="flex gap-3">
            <span aria-hidden="true" className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface-sunken text-muted">
              <Search className="h-4 w-4" />
            </span>
            <p className="min-w-0 text-xs text-muted">One page at a time: its SEO settings keep it out of search engines, or out of llms.txt. A category or tag: its Search and sharing settings.</p>
          </li>
        </ul>
      </Panel>

      <ConfirmDialog
        open={asking}
        onClose={() => {
          if (!action.pending) setAsking(false);
        }}
        title="Hide the website from search"
        confirmLabel="Hide it"
        tone="danger"
        checks={["I understand the website will drop out of search results and AI answers."]}
        pending={action.pending}
        error={action.error}
        onConfirm={save}
      >
        <ImpactList
          items={[
            { label: "Every page", value: "noindex — search engines drop it", tone: "danger" },
            { label: "Sitemap", value: "Empty", tone: "warning" },
            { label: "llms.txt", value: "Not served", tone: "warning" },
            { label: "AI crawlers", value: "All refused", tone: "warning" },
          ]}
        />
        <p>Pages already in search results go as search engines next fetch them. Showing the site again later brings them back, but not at once — it can take weeks.</p>
      </ConfirmDialog>
    </div>
  );
}

function FileLink({ icon, href, name, off = false, children }: { icon: ReactNode; href: string; name: string; off?: boolean; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span aria-hidden="true" className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface-sunken text-muted">
        {icon}
      </span>
      <div className="min-w-0">
        {off ? (
          <p className="text-[13px] font-medium text-muted">{name}</p>
        ) : (
          <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[13px] font-medium text-brand hover:underline">
            {name}
            <ExternalLink aria-hidden="true" className="h-3 w-3" />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        )}
        <p className="mt-0.5 text-xs text-muted">{children}</p>
      </div>
    </li>
  );
}
