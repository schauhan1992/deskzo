"use client";

import type { SiteSeo } from "@/components/site/blocks/types";
import { IssueScope } from "@/components/cms/editor/editor-context";
import { CheckField, ImageField, TextField } from "@/components/cms/editor/fields";
import { KeywordFields } from "@/components/cms/seo/keyword-fields";
import type { PostSeo } from "@/lib/cms/types";

/**
 * How a page or post appears in a search result and when shared: its title, description and image,
 * with a snippet showing roughly what a search engine will print, and its three primary keywords —
 * and whether search engines, and the site's llms.txt (src/lib/seo/llms.ts), list it at all.
 *
 * Every field carries `data-field-path` (its path in the document, "seo.description"), so a finding
 * in the SEO score panel can bring the cursor to it (src/components/cms/seo/focus-field.ts).
 */

const LLMS_HINT = "llms.txt lists the site's pages for AI assistants. Anything kept out of search engines is left out of it anyway.";

function Snippet({ title, url, description }: { title: string; url: string; description: string }) {
  return (
    <div aria-label="How a search result might look" role="img" className="rounded-lg border border-line bg-surface px-4 py-3">
      <p className="truncate text-xs text-muted">{url}</p>
      <p className="mt-0.5 truncate text-[17px] leading-6 text-info">{title || "Untitled"}</p>
      <p className="mt-0.5 line-clamp-2 text-[13px] leading-5 text-muted">{description || "No description yet — search engines will pick words from the page."}</p>
    </div>
  );
}

export function PageSeoFields({
  seo,
  onChange,
  titleTemplate,
  url,
  fill,
}: {
  seo: SiteSeo;
  onChange: (next: SiteSeo) => void;
  /** The site's "%s · {siteName}". */
  titleTemplate: string;
  url: string;
  fill: (text: string) => string;
}) {
  const shownTitle = seo.absoluteTitle ? fill(seo.title) : fill(titleTemplate.replace("%s", seo.title || ""));
  return (
    <IssueScope prefix="seo">
      <div className="space-y-4">
        <Snippet title={shownTitle} url={url} description={fill(seo.description)} />
        <div data-field-path="seo.title">
          <TextField label="Title in search results and the browser tab" name="title" value={seo.title} onChange={(title) => onChange({ ...seo, title })} max={120} required hint={seo.absoluteTitle ? "Shown exactly as written." : `The site adds its name: “${fill(titleTemplate)}”.`} />
        </div>
        <div data-field-path="seo.absoluteTitle">
          <CheckField label="Use this title exactly (don't add the site's name)" checked={!!seo.absoluteTitle} onChange={(absoluteTitle) => onChange({ ...seo, absoluteTitle: absoluteTitle || undefined })} />
        </div>
        <div data-field-path="seo.description">
          <TextField label="Description" name="description" value={seo.description} onChange={(description) => onChange({ ...seo, description })} max={300} multiline rows={3} hint="One or two sentences. Search engines often show it under the title." />
        </div>
        <KeywordFields value={seo.keywords} onChange={(keywords) => onChange({ ...seo, keywords })} />
        <fieldset className="space-y-4 rounded-lg border border-line p-3">
          <legend className="-ml-1 px-1 text-[13px] font-medium text-muted">When shared (LinkedIn, WhatsApp, X…)</legend>
          <div data-field-path="seo.ogTitle">
            <TextField label="Title when shared" name="ogTitle" value={seo.ogTitle} onChange={(ogTitle) => onChange({ ...seo, ogTitle: ogTitle || undefined })} max={120} hint="Leave empty to use the title above." />
          </div>
          <div data-field-path="seo.ogDescription">
            <TextField label="Description when shared" name="ogDescription" value={seo.ogDescription} onChange={(ogDescription) => onChange({ ...seo, ogDescription: ogDescription || undefined })} max={300} multiline rows={2} />
          </div>
          <div data-field-path="seo.ogImage">
            <ImageField label="Image when shared" name="ogImage" value={seo.ogImage} onChange={(ogImage) => onChange({ ...seo, ogImage })} hint="Leave empty to use the site's default image (Settings)." />
          </div>
        </fieldset>
        <div data-field-path="seo.noindex">
          <CheckField label="Keep this page out of search engines" checked={!!seo.noindex} onChange={(noindex) => onChange({ ...seo, noindex: noindex || undefined })} hint="For pages that should not be found by searching (a thank-you page, a campaign page)." />
        </div>
        <div data-field-path="seo.noLlms">
          <CheckField label="Leave this page out of llms.txt" checked={!!seo.noLlms} onChange={(noLlms) => onChange({ ...seo, noLlms: noLlms || undefined })} hint={LLMS_HINT} />
        </div>
      </div>
    </IssueScope>
  );
}

export function PostSeoFields({ seo, onChange, fallbackTitle, fallbackDescription, url }: { seo: PostSeo | null; onChange: (next: PostSeo | null) => void; fallbackTitle: string; fallbackDescription: string; url: string }) {
  const value = seo ?? {};
  const set = (next: PostSeo) => {
    const clean = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined && v !== "" && v !== false)) as PostSeo;
    onChange(Object.keys(clean).length ? clean : null);
  };
  return (
    <IssueScope prefix="seo">
      <div className="space-y-4">
        <Snippet title={value.title || fallbackTitle} url={url} description={value.description || fallbackDescription} />
        <div data-field-path="seo.title">
          <TextField label="Title in search results" name="title" value={value.title} onChange={(title) => set({ ...value, title })} max={120} hint="Leave empty to use the post's title." />
        </div>
        <div data-field-path="seo.description">
          <TextField label="Description" name="description" value={value.description} onChange={(description) => set({ ...value, description })} max={300} multiline rows={3} hint="Leave empty to use the excerpt." />
        </div>
        <KeywordFields value={value.keywords} onChange={(keywords) => set({ ...value, keywords })} />
        <div data-field-path="seo.ogImage">
          <ImageField label="Image when shared" name="ogImage" value={value.ogImage} onChange={(ogImage) => set({ ...value, ogImage })} hint="Leave empty to use the cover image." />
        </div>
        <div data-field-path="seo.noindex">
          <CheckField label="Keep this post out of search engines" checked={!!value.noindex} onChange={(noindex) => set({ ...value, noindex })} />
        </div>
        <div data-field-path="seo.noLlms">
          <CheckField label="Leave this post out of llms.txt" checked={!!value.noLlms} onChange={(noLlms) => set({ ...value, noLlms })} hint={LLMS_HINT} />
        </div>
      </div>
    </IssueScope>
  );
}
