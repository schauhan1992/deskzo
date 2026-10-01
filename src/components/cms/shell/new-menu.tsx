"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ChevronDown, FileText, ImagePlus, LoaderCircle, Newspaper, Plus } from "lucide-react";
import { cmsCreatePage } from "@/actions/cms/pages";
import { cmsCreatePost } from "@/actions/cms/posts";
import { TextField } from "@/components/cms/common/fields";
import { issuesByPath, useCmsAction } from "@/components/cms/common/use-cms-action";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Label } from "@/components/ui/input";
import { CMS_ROUTES } from "@/lib/cms/nav";
import type { PageDetail, PostDetail } from "@/lib/cms/types";
import { pageSlugProblem, slugify } from "@/lib/cms/validate";
import { cn } from "@/lib/utils";
import { ShellMenu } from "./menu";

/**
 * The top bar's "New" menu: a page, a post, or images for the library — each only for a role that may
 * make one (writers; the layout does not render the menu at all for anybody else, and the actions
 * check again). A page asks for its title and address and a post for its title, in a dialog here, so
 * "New" works from anywhere in the CMS; then the editor opens on it. Images go to the media library
 * with its uploader in front.
 */
export function NewMenu({ siteHost }: { siteHost: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const [dialog, setDialog] = useState<"page" | "post" | null>(null);
  // A dialog that sent somebody to the editor goes once the editor is on screen: it stays up, busy,
  // until the address changes. Adjusted during render, so it never paints over the new page.
  const [seenPath, setSeenPath] = useState(pathname);
  if (seenPath !== pathname) {
    setSeenPath(pathname);
    setDialog(null);
  }

  return (
    <>
      <ShellMenu
        label="New"
        width={272}
        triggerClassName="inline-flex h-8 shrink-0 items-center gap-1 rounded-base bg-brand px-2.5 text-[13px] font-medium text-brand-contrast shadow-sm transition-[filter] hover:brightness-110"
        trigger={(open) => (
          <>
            <Plus aria-hidden="true" className="h-4 w-4" />
            <span className="hidden sm:inline">New</span>
            <ChevronDown aria-hidden="true" className={cn("hidden h-3.5 w-3.5 opacity-80 transition-transform sm:block", open && "rotate-180")} />
          </>
        )}
        items={[
          { kind: "item", key: "page", label: "Page", description: "A new address on the site", icon: FileText, onSelect: () => setDialog("page") },
          { kind: "item", key: "post", label: "Post", description: "For the blog and news", icon: Newspaper, onSelect: () => setDialog("post") },
          { kind: "separator", key: "rule" },
          { kind: "item", key: "upload", label: "Upload images", description: "Into the media library", icon: ImagePlus, onSelect: () => router.push(CMS_ROUTES.mediaUpload) },
        ]}
      />
      <Dialog open={dialog === "page"} onClose={() => setDialog(null)} title="New page">
        {dialog === "page" && <NewPageForm siteHost={siteHost} onCancel={() => setDialog(null)} />}
      </Dialog>
      <Dialog open={dialog === "post"} onClose={() => setDialog(null)} title="New post">
        {dialog === "post" && <NewPostForm siteHost={siteHost} onCancel={() => setDialog(null)} />}
      </Dialog>
    </>
  );
}

/**
 * "New page" or "New post" as a button of its own — the dashboard's quick actions — with the same
 * dialog as the menu's. Render it only for a role that may write; the action checks again.
 */
export function NewItemButton({ kind, siteHost, className }: { kind: "page" | "post"; siteHost: string; className?: string }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [seenPath, setSeenPath] = useState(pathname);
  if (seenPath !== pathname) {
    setSeenPath(pathname);
    setOpen(false);
  }
  const Icon = kind === "page" ? FileText : Newspaper;
  return (
    <>
      <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)} aria-haspopup="dialog" className={className}>
        <Icon aria-hidden="true" className="h-4 w-4" />
        {kind === "page" ? "New page" : "New post"}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={kind === "page" ? "New page" : "New post"}>
        {open && (kind === "page" ? <NewPageForm siteHost={siteHost} onCancel={() => setOpen(false)} /> : <NewPostForm siteHost={siteHost} onCancel={() => setOpen(false)} />)}
      </Dialog>
    </>
  );
}

/** The server's rules for a new page's address, checked as it is typed (createPage checks them again). */
const slugProblem = pageSlugProblem;

/** Puts focus in the first field a frame after the dialog has put it on its close button. */
function useFocusFirst() {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => ref.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);
  return ref;
}

function NewPageForm({ siteHost, onCancel }: { siteHost: string; onCancel: () => void }) {
  const router = useRouter();
  const id = useId();
  const action = useCmsAction<PageDetail>();
  const titleRef = useFocusFirst();
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [tried, setTried] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const busy = action.pending || leaving;

  const cleanSlug = slug.trim().toLowerCase().replace(/^\/+|\/+$/g, "");
  const slugError = cleanSlug || tried ? slugProblem(cleanSlug) : null;
  const titleError = tried && !title.trim() ? "Give the page a title." : null;
  const server = issuesByPath(action.issues);
  const slugId = `${id}-slug`;
  const slugHintId = `${id}-slug-hint`;

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setTried(true);
    if (busy || !title.trim() || slugProblem(cleanSlug)) return;
    action.run(() => cmsCreatePage({ title: title.trim(), slug: cleanSlug }), {
      refresh: false,
      onDone: (page) => {
        setLeaving(true);
        router.push(CMS_ROUTES.page(page.id));
      },
    });
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4 p-0.5" aria-busy={busy || undefined}>
      <p className="text-sm text-muted">It starts as a draft with a heading — nothing is on the site until somebody publishes it.</p>
      <TextField
        inputRef={titleRef}
        label="Title"
        value={title}
        onChange={(v) => {
          setTitle(v);
          if (!slugEdited) setSlug(slugify(v, 80));
        }}
        max={120}
        required
        placeholder="About us"
        error={titleError ?? server.title}
        readOnly={busy}
      />
      <div className="space-y-1.5">
        <Label htmlFor={slugId}>
          Address
          <span aria-hidden="true" className="ml-0.5 text-danger">
            *
          </span>
        </Label>
        <div className={cn("flex h-9 items-center overflow-hidden rounded-base border bg-surface shadow-sm focus-within:border-brand", slugError || server.slug ? "border-danger" : "border-line-strong")}>
          <span aria-hidden="true" className="flex h-full shrink-0 items-center border-r border-line bg-surface-sunken px-2.5 font-mono text-xs text-muted">
            {siteHost}/
          </span>
          <input
            id={slugId}
            value={slug}
            onChange={(e) => {
              setSlug(e.target.value.toLowerCase());
              setSlugEdited(true);
            }}
            placeholder="about"
            autoComplete="off"
            spellCheck={false}
            data-1p-ignore=""
            aria-required
            aria-invalid={slugError || server.slug ? true : undefined}
            aria-describedby={slugHintId}
            readOnly={busy}
            className="h-full min-w-0 flex-1 bg-transparent px-2.5 font-mono text-[13px] text-text outline-none placeholder:text-subtle"
          />
        </div>
        <p id={slugHintId} className={cn("text-xs", slugError || server.slug ? "text-danger" : "text-muted")}>
          {slugError ?? server.slug ?? "Follows the title until you change it. Only an editor can change it after publishing."}
        </p>
      </div>
      <ActionNoticeRegion notice={action.error ? { tone: "error", message: action.error } : null} />
      <div className="sticky bottom-0 flex flex-col-reverse gap-2 bg-surface pt-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" aria-disabled={busy || undefined} aria-busy={busy || undefined} className={busy ? "cursor-wait opacity-70" : undefined}>
          {busy && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
          {leaving ? "Opening the editor…" : "Create page"}
        </Button>
      </div>
    </form>
  );
}

function NewPostForm({ siteHost, onCancel }: { siteHost: string; onCancel: () => void }) {
  const router = useRouter();
  const action = useCmsAction<PostDetail>();
  const titleRef = useFocusFirst();
  const [title, setTitle] = useState("");
  const [tried, setTried] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const busy = action.pending || leaving;
  const server = issuesByPath(action.issues);
  const preview = slugify(title, 80);

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setTried(true);
    if (busy || !title.trim()) return;
    action.run(() => cmsCreatePost({ title: title.trim() }), {
      refresh: false,
      onDone: (post) => {
        setLeaving(true);
        router.push(CMS_ROUTES.post(post.id));
      },
    });
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4 p-0.5" aria-busy={busy || undefined}>
      <p className="text-sm text-muted">A draft with you as its author. Write it, then publish it now or schedule it.</p>
      <TextField
        inputRef={titleRef}
        label="Title"
        value={title}
        onChange={setTitle}
        max={200}
        required
        placeholder="What's new this month"
        error={(tried && !title.trim() ? "Give the post a title." : null) ?? server.title}
        hint={
          <>
            Its address will be{" "}
            <span translate="no" className="font-mono text-text">
              {siteHost}/blog/{preview || "…"}
            </span>{" "}
            — you can change it in the editor.
          </>
        }
        readOnly={busy}
      />
      <ActionNoticeRegion notice={action.error ? { tone: "error", message: action.error } : null} />
      <div className="sticky bottom-0 flex flex-col-reverse gap-2 bg-surface pt-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" aria-disabled={busy || undefined} aria-busy={busy || undefined} className={busy ? "cursor-wait opacity-70" : undefined}>
          {busy && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
          {leaving ? "Opening the editor…" : "Create post"}
        </Button>
      </div>
    </form>
  );
}
