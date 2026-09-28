"use client";

import type { SiteSeo } from "@/components/site/blocks/types";
import { IssueScope } from "@/components/cms/editor/editor-context";
import { CheckField, ImageField, TextField } from "@/components/cms/editor/fields";
import type { PostSeo } from "@/lib/cms/types";

/**
 * How a page or post appears in a search result and when shared: its title, description and image,
 * with a snippet showing roughly what a search engine will print.
 */

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
        <TextField label="Title in search results and the browser tab" name="title" value={seo.title} onChange={(title) => onChange({ ...seo, title })} max={120} required hint={seo.absoluteTitle ? "Shown exactly as written." : `The site adds its name: “${fill(titleTemplate)}”.`} />
        <CheckField label="Use this title exactly (don't add the site's name)" checked={!!seo.absoluteTitle} onChange={(absoluteTitle) => onChange({ ...seo, absoluteTitle: absoluteTitle || undefined })} />
        <TextField label="Description" name="description" value={seo.description} onChange={(description) => onChange({ ...seo, description })} max={300} multiline rows={3} hint="One or two sentences. Search engines often show it under the title." />
        <fieldset className="space-y-4 rounded-lg border border-line p-3">
          <legend className="-ml-1 px-1 text-[13px] font-medium text-muted">When shared (LinkedIn, WhatsApp, X…)</legend>
          <TextField label="Title when shared" name="ogTitle" value={seo.ogTitle} onChange={(ogTitle) => onChange({ ...seo, ogTitle: ogTitle || undefined })} max={120} hint="Leave empty to use the title above." />
          <TextField label="Description when shared" name="ogDescription" value={seo.ogDescription} onChange={(ogDescription) => onChange({ ...seo, ogDescription: ogDescription || undefined })} max={300} multiline rows={2} />
          <ImageField label="Image when shared" name="ogImage" value={seo.ogImage} onChange={(ogImage) => onChange({ ...seo, ogImage })} hint="Leave empty to use the site's default image (Settings)." />
        </fieldset>
        <CheckField label="Keep this page out of search engines" checked={!!seo.noindex} onChange={(noindex) => onChange({ ...seo, noindex: noindex || undefined })} hint="For pages that should not be found by searching (a thank-you page, a campaign page)." />
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
        <TextField label="Title in search results" name="title" value={value.title} onChange={(title) => set({ ...value, title })} max={120} hint="Leave empty to use the post's title." />
        <TextField label="Description" name="description" value={value.description} onChange={(description) => set({ ...value, description })} max={300} multiline rows={3} hint="Leave empty to use the excerpt." />
        <ImageField label="Image when shared" name="ogImage" value={value.ogImage} onChange={(ogImage) => set({ ...value, ogImage })} hint="Leave empty to use the cover image." />
        <CheckField label="Keep this post out of search engines" checked={!!value.noindex} onChange={(noindex) => set({ ...value, noindex })} />
      </div>
    </IssueScope>
  );
}
