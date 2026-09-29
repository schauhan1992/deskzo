"use client";

import { useCallback, useDeferredValue, useEffect, useId, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarClock, ChevronRight, Eye, LoaderCircle, Redo2, Send, Undo2 } from "lucide-react";
import { cmsArchivePost, cmsDeletePost, cmsGetPost, cmsPostPreviewLink, cmsPublishPost, cmsSavePost, cmsUnarchivePost, cmsUnpublishPost } from "@/actions/cms/posts";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { useConsoleNotice } from "@/components/console/kit/notice";
import { RowMenu, type RowMenuItem } from "@/components/console/kit/row-menu";
import type { SiteBlock, SiteRenderContext } from "@/components/site/blocks/types";
import { BlockList } from "@/components/cms/editor/block-list";
import { BLOCK_INFO } from "@/components/cms/editor/catalog";
import { postIssues } from "@/components/cms/editor/checks";
import { groupIssues, insertItem, mergeIssues, type FieldIssue } from "@/components/cms/editor/doc-utils";
import { PostStatusPill } from "@/components/cms/common/status";
import { ConflictDialog, EditorBanner, LeaveDialog, SaveState, ShortcutsDialog, UndoToast, useEditorNotice, type Toast } from "@/components/cms/editor/editor-chrome";
import { EditorEnvProvider, IssueRoot, useIssuesAt } from "@/components/cms/editor/editor-context";
import { EditorShell, PaneTabs } from "@/components/cms/editor/editor-shell";
import { ImageField, TextField } from "@/components/cms/editor/fields";
import { PreviewBlocks, PreviewChrome, PreviewPostHeader } from "@/components/cms/editor/preview-blocks";
import { PreviewFrame } from "@/components/cms/editor/preview-frame";
import { CategoriesField, TagsTokenField, type TagNames } from "@/components/cms/editor/post-terms";
import { PostSeoFields } from "@/components/cms/editor/seo-fields";
import { useAutosave, useBeforeUnload, useDraftEditor, useEditorKeys, useLinkGuard } from "@/components/cms/editor/use-draft-editor";
import { MediaPicker } from "@/components/cms/media/media-picker";
import { postDraftInput, type PostDraftSource } from "@/components/cms/seo/editor-input";
import { focusBlockCard, focusFieldPath } from "@/components/cms/seo/focus-field";
import { SeoScorePanel, SeoTabBadge } from "@/components/cms/seo/score-panel";
import { useLiveSeo } from "@/components/cms/seo/use-live-score";
import { ActionNotice } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { IconButton } from "@/components/ui/icon-button";
import { Input, Label } from "@/components/ui/input";
import { CMS_ROUTES } from "@/lib/cms/nav";
import { normaliseTarget } from "@/lib/cms/redirect-rules";
import {
  POST_BLOCK_TYPES,
  type AutoRedirect,
  type CategoryNode,
  type CmsCaps,
  type CmsIssue,
  type CmsMe,
  type CmsTermRef,
  type MediaRow,
  type PostDetail,
  type PostInput,
  type PostSaved,
  type SitePostStatus,
} from "@/lib/cms/types";
import { mediaIdOf, slugify, stableJson } from "@/lib/cms/validate";
import { formatIstDate, formatIstDateTime, istDateTimeInput } from "@/lib/india-time";
import { parseSeoField } from "@/lib/seo/extract";
import { cn } from "@/lib/utils";

/**
 * The post editor: the same block editor and live preview as pages, for a post's body, with what a
 * post has besides — title, excerpt, cover image, categories and tags (./post-terms.tsx), its
 * address under /blog, the author, and publishing now or at a set time (India time) — with its SEO,
 * AEO and GEO scores worked out live from the draft (src/components/cms/seo). A live post's
 * new address leaves a 301 from the old one, and the editor says so; deleting a post that was ever
 * on the site offers editors and admins a redirect for its old address.
 *
 * A post has one body, not a draft and a published copy: while it is a draft, it saves itself every 30
 * seconds; once it is published or scheduled, a save changes what the site shows, so it is saved only
 * when asked ("Update post") and checked as fully as publishing is.
 */

export type PostEditorProps = {
  post: PostDetail;
  caps: CmsCaps;
  me: CmsMe;
  ctx: SiteRenderContext;
  year: number;
  siteOrigin: string;
  sitePaths: string[];
  media: MediaRow[];
  /** The category tree, for the post's categories checklist. */
  categories: CategoryNode[];
};

type Meta = { status: SitePostStatus; live: boolean; archived: boolean; publishAt: Date | null; slug: string; wasPublished: boolean };
type Confirm = "unpublish" | "archive" | "delete" | null;

const postFingerprint = (doc: PostInput) => stableJson(doc);
/** The editor's copy of a saved post (exported for check:cms, which holds its live SEO score to the dashboard's). */
export const inputOf = (post: PostDetail): PostInput => ({
  title: post.title,
  slug: post.slug,
  excerpt: post.excerpt,
  coverMediaId: post.coverMediaId,
  tags: post.tags,
  categories: post.categories.map((c) => c.id),
  body: post.body,
  seo: post.seo,
});
const toFieldIssues = (issues: CmsIssue[]): FieldIssue[] => issues.map((i) => ({ path: i.path, message: i.message }));
const CONTENT_PATHS = /^(title|excerpt|coverMediaId|tags|categories)/;
const namesOf = (refs: CmsTermRef[]): TagNames => Object.fromEntries(refs.map((t) => [t.slug, t.name]));

export function PostEditor({ post, caps, me, ctx, year, siteOrigin, sitePaths, media: initialMedia, categories }: PostEditorProps) {
  const router = useRouter();
  const notice = useEditorNotice();
  const pageNotice = useConsoleNotice();
  const [meta, setMeta] = useState<Meta>(() => ({ status: post.status, live: post.live, archived: post.archived, publishAt: post.publishAt, slug: post.slug, wasPublished: post.wasPublished }));
  // Tag names by address — the post's own, then whatever a search turns up — so a chip reads "Product news", not "product-news".
  const [tagNames, setTagNames] = useState<TagNames>(() => namesOf(post.tagRefs));
  const learnTags = useCallback((refs: CmsTermRef[]) => {
    setTagNames((known) => (refs.every((t) => known[t.slug] === t.name) ? known : { ...known, ...namesOf(refs) }));
  }, []);
  /** The 301 the last save of a live post left behind when its address changed. */
  const [autoRedirect, setAutoRedirect] = useState<AutoRedirect | null>(null);
  /** When it was last saved — the "Updated" date the site may show, which the SEO score reads. */
  const [savedAt, setSavedAt] = useState<Date>(post.updatedAt);
  const onSite = meta.status !== "DRAFT";
  const mayChange = caps.write && !meta.archived && (me.role !== "AUTHOR" || (post.author.id === me.id && meta.status === "DRAFT"));
  const readOnly = !mayChange;
  const canPublish = caps.publish && !meta.archived;
  const mayArchive = caps.write && (me.role !== "AUTHOR" || (post.author.id === me.id && meta.status === "DRAFT"));

  const editor = useDraftEditor<PostInput, PostSaved>({
    initial: inputOf(post),
    initialVersion: post.version,
    initialSavedAt: post.updatedAt,
    fingerprint: postFingerprint,
    canSave: !readOnly,
    send: (doc, version, force) => cmsSavePost(post.id, { post: doc, version, force }),
    onSaved: (data, saved) => {
      setMeta((m) => ({ ...m, status: data.status, live: data.live, publishAt: data.publishAt, slug: data.slug }));
      setSavedAt(data.updatedAt);
      if (data.redirect) setAutoRedirect(data.redirect);
      // Tags named for the first time exist now, so their chips stop saying "new".
      setTagNames((known) => {
        const fresh = saved.tags.filter((t) => !known[t] && !Object.values(known).some((name) => name.toLowerCase() === t.toLowerCase()));
        return fresh.length ? { ...known, ...Object.fromEntries(fresh.map((t) => [t, t])) } : known;
      });
    },
  });
  const doc = editor.doc;
  const deferred = useDeferredValue(doc);

  const [media, setMedia] = useState<Record<string, MediaRow>>(() => Object.fromEntries(initialMedia.map((m) => [m.id, m])));
  const [picker, setPicker] = useState<{ resolve: (row: MediaRow | null) => void } | null>(null);
  const env = useMemo(() => ({ readOnly, sitePaths, media, pickImage: () => new Promise<MediaRow | null>((resolve) => setPicker({ resolve })) }), [readOnly, sitePaths, media]);
  const closePicker = (row: MediaRow | null) => {
    if (row) setMedia((m) => ({ ...m, [row.id]: row }));
    picker?.resolve(row);
    setPicker(null);
  };

  // A live post is checked as fully as publishing; a draft only for what would stop it saving.
  const [publishCheck, setPublishCheck] = useState(false);
  const saveCheck = useMemo(() => postIssues(doc, onSite ? "publish" : "draft", media), [doc, onSite, media]);
  const publishIssues = useMemo(() => (publishCheck && !onSite ? postIssues(deferred, "publish", media) : []), [publishCheck, onSite, deferred, media]);
  const issues = useMemo(() => mergeIssues(saveCheck, publishIssues, editor.serverIssues), [saveCheck, publishIssues, editor.serverIssues]);
  const grouped = useMemo(() => groupIssues(issues, doc.body, "body"), [issues, doc.body]);
  const contentIssues = grouped.document.filter((i) => CONTENT_PATHS.test(i.path));
  const settingsIssues = grouped.document.filter((i) => i.path.startsWith("slug") || i.path.startsWith("seo"));
  const bodyIssues = grouped.document.filter((i) => i.path === "body");

  useAutosave(editor, { enabled: !readOnly && !onSite, blocked: saveCheck.length > 0 });
  useBeforeUnload((editor.dirty && !readOnly) || editor.saving);
  const [leaveTo, setLeaveTo] = useState<string | null>(null);
  useLinkGuard(editor.dirty && !readOnly, setLeaveTo);
  useEditorKeys({ onSave: () => void saveNow(), onUndo: editor.undo, onRedo: editor.redo });

  const [tab, setTab] = useState<"content" | "settings">("content");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(() => new Set(post.body.length <= 2 ? post.body.map((b) => b.id) : []));
  const [scrollTo, setScrollTo] = useState<{ id: string } | null>(null);
  const [reveal, setReveal] = useState<{ id: string } | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [showChrome, setShowChrome] = useState(true);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [scheduling, setScheduling] = useState<{ mode: "now" | "later"; when: string } | null>(null);
  const [busy, startBusy] = useTransition();

  const setOpen = (id: string, open: boolean) =>
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  const set = <K extends keyof PostInput>(key: K, value: PostInput[K]) => editor.update((d) => ({ ...d, [key]: value }), key);
  const updateBlocks = (fn: (blocks: SiteBlock[]) => SiteBlock[], key?: string) => editor.update((d) => ({ ...d, body: fn(d.body) }), key);
  const removeBlock = (block: SiteBlock, index: number) => {
    updateBlocks((list) => list.filter((b) => b.id !== block.id));
    setToast({ id: Date.now(), message: `Removed “${BLOCK_INFO[block.type]?.label ?? "block"}”.`, undo: () => updateBlocks((list) => (list.some((b) => b.id === block.id) ? list : insertItem(list, index, block))) });
  };
  const openFirstIssue = (list: CmsIssue[]) => {
    const g = groupIssues(list, doc.body, "body");
    const first = doc.body.find((b) => g.byBlock.has(b.id));
    if (first) {
      setTab("content");
      setOpen(first.id, true);
      setActiveId(first.id);
      setReveal({ id: first.id });
    } else if (g.document.some((i) => i.path.startsWith("slug") || i.path.startsWith("seo"))) setTab("settings");
    else setTab("content");
  };

  // ─── The SEO score, live, and going to what a finding is about ─────────────────────────────────
  const categoryIndex = useMemo(() => Object.fromEntries(categories.flatMap((c) => [c, ...c.children]).map((c) => [c.id, { slug: c.slug, name: c.name }])), [categories]);
  const seoSource = useMemo<PostDraftSource>(
    () => ({ id: post.id, doc: deferred, status: meta.status, publishAt: meta.publishAt, updatedAt: savedAt, author: post.author.name, savedCategories: post.categories, categories: categoryIndex, tagNames, media }),
    [post.id, post.author.name, post.categories, deferred, meta.status, meta.publishAt, savedAt, categoryIndex, tagNames, media],
  );
  // Publishing, unpublishing and saving a post on the site recalculate the dashboard's number: fetch the context again for it.
  const liveSeo = useLiveSeo("post", post.id, seoSource, postDraftInput, { refresh: `${meta.status}:${meta.publishAt?.getTime() ?? 0}:${onSite ? savedAt.getTime() : 0}` });
  const [jump, setJump] = useState<{ path: string } | { blockId: string } | null>(null);
  useEffect(() => {
    if (!jump) return;
    // After the tab that holds it has rendered.
    const frame = window.requestAnimationFrame(() => void ("blockId" in jump ? focusBlockCard(jump.blockId) : focusFieldPath(jump.path)));
    return () => window.cancelAnimationFrame(frame);
  }, [jump]);
  /** A finding's field: a body block opens in Content; the header fields are in Content, the address, SEO and author in their own tab. */
  const jumpTo = (field: string) => {
    const target = parseSeoField(field);
    if (!target) return;
    if (target.kind === "block") {
      const block = doc.body.find((b) => b.id === target.blockId) ?? (/^\d+$/.test(target.blockId) ? doc.body[Number(target.blockId)] : undefined);
      setTab("content");
      if (!block) return;
      setOpen(block.id, true);
      setActiveId(block.id);
      setReveal({ id: block.id });
      setScrollTo({ id: block.id });
      setJump({ blockId: block.id });
      return;
    }
    setTab(/^(slug|seo|author|publishAt)/.test(target.path) ? "settings" : "content");
    setJump({ path: target.path });
  };

  async function saveNow(): Promise<boolean> {
    if (readOnly) return false;
    if (saveCheck.length) {
      notice.show("error", onSite ? "This post is on the site, so every field must be ready before it saves. Fix the highlighted fields." : "Fix the highlighted fields first — the draft can't be saved with them.");
      openFirstIssue(saveCheck);
      return false;
    }
    const ok = await editor.save();
    if (ok) notice.show("success", onSite ? "Updated — the site shows the change now." : "Draft saved.");
    return ok;
  }

  const askPublish = () => {
    const problems = postIssues(doc, "publish", media);
    setPublishCheck(true);
    if (problems.length) {
      notice.show("error", `${problems.length === 1 ? "One field needs" : `${problems.length} fields need`} attention before this can be published.`);
      openFirstIssue(problems);
      return;
    }
    const scheduled = meta.status === "SCHEDULED" && !meta.live && meta.publishAt;
    // Now, in India time, worked out in the click — never while rendering.
    setScheduling({ mode: scheduled ? "later" : "now", when: istDateTimeInput(scheduled ? meta.publishAt : new Date()) });
  };

  const publish = () =>
    startBusy(async () => {
      if (!scheduling) return;
      try {
        let version = editor.version;
        if (editor.dirty) {
          if (!(await editor.save())) {
            setScheduling(null);
            notice.show("error", "The post didn't save, so it wasn't published. See the messages above.");
            return;
          }
          const fresh = await cmsGetPost(post.id);
          if (fresh.ok) version = fresh.data.version;
        }
        const result = await cmsPublishPost(post.id, { publishAt: scheduling.mode === "later" ? scheduling.when : null, version });
        setScheduling(null);
        if (!result.ok) {
          if (result.conflict) editor.raiseConflict(result.conflict);
          else {
            if (result.issues?.length) {
              editor.showServerIssues(result.issues);
              openFirstIssue(result.issues);
            }
            notice.show("error", result.error);
          }
          return;
        }
        editor.markSaved(doc, result.data.version);
        setMeta((m) => ({ ...m, status: result.data.status, live: result.data.live, publishAt: result.data.publishAt, wasPublished: true }));
        setSavedAt(result.data.updatedAt);
        setPublishCheck(false);
        notice.show(
          "success",
          result.data.status === "SCHEDULED" && result.data.publishAt && !result.data.live
            ? `Scheduled — it goes live ${formatIstDateTime(result.data.publishAt)} (India time).`
            : `Published — /blog/${result.data.slug} is live.`,
        );
      } catch {
        setScheduling(null);
        notice.show("error", "Publishing didn't finish. Nothing may have changed — try again.");
      }
    });

  const simple = (work: () => Promise<{ ok: true } | { ok: false; error: string }>, done: () => void) =>
    startBusy(async () => {
      try {
        const result = await work();
        setConfirm(null);
        if (result.ok) done();
        else notice.show("error", result.error);
      } catch {
        setConfirm(null);
        notice.show("error", "That didn't finish. Try again.");
      }
    });

  const unpublish = () =>
    simple(
      () => cmsUnpublishPost(post.id),
      () => {
        setMeta((m) => ({ ...m, status: "DRAFT", live: false, publishAt: null }));
        notice.show("success", "Unpublished — the post is a draft again and off the site.");
      },
    );
  const archive = () =>
    simple(
      () => cmsArchivePost(post.id),
      () => {
        setMeta((m) => ({ ...m, archived: true, status: "DRAFT", live: false, publishAt: null }));
        notice.show("success", "Archived — the post is off the site and out of the list.");
      },
    );
  const unarchive = () =>
    simple(
      () => cmsUnarchivePost(post.id),
      () => {
        setMeta((m) => ({ ...m, archived: false }));
        notice.show("success", "Restored from the archive, as a draft.");
      },
    );
  const reloadTheirs = () =>
    startBusy(async () => {
      try {
        const fresh = await cmsGetPost(post.id);
        if (!fresh.ok) {
          notice.show("error", fresh.error);
          return;
        }
        learnTags(fresh.data.tagRefs);
        editor.load(inputOf(fresh.data), fresh.data.version);
        setSavedAt(fresh.data.updatedAt);
        setMeta({ status: fresh.data.status, live: fresh.data.live, archived: fresh.data.archived, publishAt: fresh.data.publishAt, slug: fresh.data.slug, wasPublished: fresh.data.wasPublished });
        notice.show("info", "Their version is loaded. Yours is one Undo away (Ctrl/⌘+Z) if you need anything from it.");
      } catch {
        notice.show("error", "Their version didn't load. Try again.");
      }
    });

  const openPreviewTab = () => {
    const win = window.open("about:blank", "_blank");
    startBusy(async () => {
      try {
        if (editor.dirty && !readOnly && !onSite) {
          if (saveCheck.length || !(await editor.save())) {
            win?.close();
            notice.show("error", "Save the draft first — the preview shows the saved post.");
            return;
          }
        }
        const result = await cmsPostPreviewLink(post.id);
        if (!result.ok) {
          win?.close();
          notice.show("error", result.error);
          return;
        }
        if (win) {
          win.opener = null;
          win.location.href = result.data.url;
          notice.show("info", onSite && editor.dirty ? "The preview shows the saved post — your unsaved changes are not in it yet." : "The preview opened in a new tab. Its link works for 15 minutes.");
        } else notice.show("info", `Your browser blocked the new tab. Open the preview here: ${result.data.url}`);
      } catch {
        win?.close();
        notice.show("error", "The preview link wasn't made. Try again.");
      }
    });
  };

  const leave = (save: boolean) =>
    startBusy(async () => {
      const href = leaveTo;
      if (!href) return;
      if (save && !(await saveNow())) {
        setLeaveTo(null);
        return;
      }
      setLeaveTo(null);
      router.push(href);
    });

  const title = doc.title.trim() || "Untitled post";
  const liveUrl = `${siteOrigin}/blog/${meta.slug}`;
  const coverRow = doc.coverMediaId ? media[doc.coverMediaId] : undefined;
  const dateLabel = meta.publishAt ? formatIstDate(meta.publishAt) : "Not published yet";

  const menu: RowMenuItem[] = [
    ...(meta.live ? [{ key: "view", label: "View on the site", href: liveUrl, external: true }] : []),
    { key: "shortcuts", label: "Keyboard shortcuts", onSelect: () => setShortcutsOpen(true) },
    ...(canPublish && onSite ? [{ key: "sep1", separator: true as const }, { key: "unpublish", label: "Unpublish…", onSelect: () => setConfirm("unpublish") }] : []),
    ...(mayArchive && !meta.archived ? [{ key: "sep2", separator: true as const }, { key: "archive", label: "Archive…", onSelect: () => setConfirm("archive"), danger: true }] : []),
    ...(caps.write && meta.archived && (me.role !== "AUTHOR" || post.author.id === me.id)
      ? [{ key: "sep3", separator: true as const }, { key: "unarchive", label: "Restore from the archive", onSelect: unarchive }, { key: "delete", label: "Delete for good…", onSelect: () => setConfirm("delete"), danger: true }]
      : []),
  ];

  const header = (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="min-w-0 flex-1">
        <nav aria-label="Breadcrumb">
          <ol className="flex items-center gap-1 text-xs text-muted">
            <li>
              <Link href="/posts" className="hover:text-text">
                Posts
              </Link>
            </li>
            <li aria-hidden="true">
              <ChevronRight className="h-3 w-3" />
            </li>
            <li className="truncate font-mono">/blog/{meta.slug}</li>
          </ol>
        </nav>
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-2">
          <h1 className="truncate text-lg font-semibold tracking-tight text-text">{title}</h1>
          <PostStatusPill status={meta.status} live={meta.live} archived={meta.archived} />
          {meta.status === "SCHEDULED" && !meta.live && meta.publishAt && <span className="text-xs text-muted">{formatIstDateTime(meta.publishAt)}</span>}
        </div>
      </div>
      <SaveState
        saving={editor.saving}
        dirty={editor.dirty}
        blocked={onSite ? 0 : saveCheck.length}
        conflict={!!editor.conflict}
        failure={editor.failure}
        autosave={!onSite && !readOnly}
        lastSavedAt={editor.lastSavedAt}
        neverSaved={null}
        readOnly={readOnly}
      />
      <div className="flex flex-wrap items-center gap-1.5">
        {!readOnly && (
          <>
            <IconButton icon={Undo2} label="Undo (Ctrl+Z)" onClick={editor.undo} disabled={!editor.canUndo} />
            <IconButton icon={Redo2} label="Redo (Ctrl+Shift+Z)" onClick={editor.redo} disabled={!editor.canRedo} />
          </>
        )}
        <Button type="button" variant="secondary" size="sm" onClick={openPreviewTab} disabled={busy}>
          <Eye aria-hidden="true" className="h-4 w-4" />
          Preview
        </Button>
        {!readOnly && (
          <Button type="button" variant={canPublish && !onSite ? "secondary" : "primary"} size="sm" onClick={() => void saveNow()} disabled={editor.saving || (onSite && !editor.dirty)} aria-keyshortcuts="Control+S">
            {editor.saving && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
            {onSite ? "Update post" : "Save draft"}
          </Button>
        )}
        {canPublish && (!onSite || (meta.status === "SCHEDULED" && !meta.live)) && (
          <Button type="button" size="sm" onClick={askPublish} disabled={busy || editor.saving}>
            {meta.status === "SCHEDULED" ? <CalendarClock aria-hidden="true" className="h-4 w-4" /> : <Send aria-hidden="true" className="h-4 w-4" />}
            {meta.status === "SCHEDULED" ? "Reschedule" : "Publish"}
          </Button>
        )}
        <RowMenu label="More post actions" items={menu} />
      </div>
    </div>
  );

  const banners = (
    <>
      <div aria-live="polite">{notice.notice && <ActionNotice tone={notice.notice.tone}>{notice.notice.message}</ActionNotice>}</div>
      {meta.archived && (
        <EditorBanner
          tone="warning"
          title="This post is archived"
          action={
            caps.write && (me.role !== "AUTHOR" || post.author.id === me.id) ? (
              <Button type="button" variant="secondary" size="sm" onClick={unarchive} disabled={busy}>
                Restore
              </Button>
            ) : undefined
          }
        >
          It is off the site and out of the posts list.
        </EditorBanner>
      )}
      {onSite && !meta.archived && !readOnly && (
        <EditorBanner tone="warning" title={meta.live ? "This post is live" : `This post is scheduled for ${meta.publishAt ? formatIstDateTime(meta.publishAt) : "later"}`}>
          {meta.live ? "Saving updates the site at once, so it doesn't save itself — press “Update post” when the change is ready." : "Saving changes what goes live then. It doesn't save itself — press “Update post”."}
        </EditorBanner>
      )}
      {!caps.write && <EditorBanner tone="info" title="You can look, not change">Your role reads the CMS. Ask an editor to make changes.</EditorBanner>}
      {caps.write && !mayChange && !meta.archived && me.role === "AUTHOR" && (
        <EditorBanner tone="info" title="Read only for you">{post.author.id === me.id ? "It is published or scheduled — an editor or admin changes it now." : `It is ${post.author.name}'s post. Authors change only their own drafts.`}</EditorBanner>
      )}
      {caps.write && mayChange && !caps.publish && <EditorBanner tone="info" title="Your changes are saved as a draft">An editor or admin publishes it.</EditorBanner>}
      {editor.failure && !editor.serverIssues.length && (
        <EditorBanner tone="danger" title="The post didn't save" action={!readOnly ? <Button type="button" size="sm" variant="secondary" onClick={() => void saveNow()}>Try again</Button> : undefined}>
          {editor.failure}
        </EditorBanner>
      )}
      {editor.serverIssues.length > 0 && <EditorBanner tone="danger" title={editor.failure ?? "Some fields need attention"}>The fields are marked in red.</EditorBanner>}
      {autoRedirect && (
        <EditorBanner
          tone="success"
          title={`A redirect was created from ${autoRedirect.from}`}
          action={
            <Button type="button" variant="ghost" size="sm" onClick={() => setAutoRedirect(null)}>
              Dismiss
            </Button>
          }
        >
          {`Anyone who asks for ${autoRedirect.from} — an old link, a search engine — is sent to ${autoRedirect.to} (301, permanent)${autoRedirect.created ? "" : "; the redirect that was already there is updated"}. `}
          {caps.publish && (
            <Link href={CMS_ROUTES.redirects} className="font-medium underline">
              See the redirects
            </Link>
          )}
        </EditorBanner>
      )}
      {publishCheck && publishIssues.length > 0 && !editor.serverIssues.length && (
        <EditorBanner tone="warning" title={`${publishIssues.length === 1 ? "One field needs" : `${publishIssues.length} fields need`} attention before publishing`} action={<Button type="button" variant="ghost" size="sm" onClick={() => setPublishCheck(false)}>Hide</Button>}>
          They are marked in red. The draft can be saved as it is.
        </EditorBanner>
      )}
    </>
  );

  const edit = (
    <div className="min-w-0">
      <PaneTabs
        label="Edit"
        active={tab}
        onChange={setTab}
        tabs={[
          { key: "content", label: "Content", badge: issues.length - settingsIssues.length || undefined },
          { key: "settings", label: "Address, SEO & author", badge: settingsIssues.length || undefined, extra: <SeoTabBadge live={liveSeo} /> },
        ]}
      />
      <div hidden={tab !== "content"} className="space-y-6">
        <fieldset disabled={readOnly} className="min-w-0 space-y-4">
          <legend className="sr-only">The post</legend>
          <IssueRoot issues={toFieldIssues(contentIssues)}>
            <div data-field-path="title">
              <TextField label="Title" name="title" value={doc.title} onChange={(v) => set("title", v)} max={200} required />
            </div>
            <div data-field-path="excerpt">
              <TextField label="Excerpt" name="excerpt" value={doc.excerpt ?? ""} onChange={(v) => set("excerpt", v || null)} max={500} multiline rows={3} hint="Under the title, in the blog list and when shared." />
            </div>
            <div data-field-path="coverMediaId">
              <ImageField
                label="Cover image"
                name="coverMediaId"
                value={doc.coverMediaId ? `/media/${doc.coverMediaId}` : undefined}
                onChange={(src) => set("coverMediaId", mediaIdOf(src))}
                hint={coverRow?.needsAlt ? undefined : "Across the top of the post and on its card in the blog."}
              />
            </div>
            <div data-field-path="categories">
              <CategoriesField value={doc.categories ?? []} onChange={(v) => set("categories", v)} categories={categories} canManage={caps.publish} />
            </div>
            <div data-field-path="tags">
              <TagsTokenField value={doc.tags} onChange={(v) => set("tags", v)} names={tagNames} onLearn={learnTags} />
            </div>
          </IssueRoot>
        </fieldset>
        <section aria-labelledby="post-body-heading" data-field-path="body" className="space-y-2 border-t border-line pt-5">
          <h2 id="post-body-heading" className="text-sm font-semibold text-text">
            Body
          </h2>
          {bodyIssues.map((i, n) => (
            <p key={n} role="alert" className="rounded-md border border-danger/30 bg-danger-bg px-3 py-2 text-xs text-danger">
              {i.message}
            </p>
          ))}
          <BlockList
            blocks={doc.body}
            allowed={POST_BLOCK_TYPES}
            requiredBlock={null}
            issues={grouped.byBlock}
            activeId={activeId}
            openIds={openIds}
            reveal={reveal}
            readOnly={readOnly}
            onOpenChange={setOpen}
            onOpenAll={(open) => setOpenIds(new Set(open ? doc.body.map((b) => b.id) : []))}
            onActivate={(id) => {
              setActiveId(id);
              setScrollTo({ id });
            }}
            onBlocksChange={updateBlocks}
            onRemove={removeBlock}
          />
        </section>
      </div>
      <div hidden={tab !== "settings"} className="min-w-0 space-y-6">
        {/* Outside the fieldset: a viewer switches its tabs and follows its findings too. */}
        <SeoScorePanel
          live={liveSeo}
          entity={meta.archived ? null : { type: "POST", key: post.id }}
          canRecalculate={caps.write}
          onJump={jumpTo}
          fullAnalysisHref={meta.archived ? undefined : CMS_ROUTES.seoDetail("post", post.id)}
        />
        <fieldset disabled={readOnly} className="min-w-0 space-y-6">
          <legend className="sr-only">Address, SEO and author</legend>
          <IssueRoot issues={toFieldIssues(settingsIssues)}>
            <section data-field-path="slug" className="space-y-2">
              <SlugField value={doc.slug} onChange={(v) => set("slug", v)} onSuggest={() => set("slug", slugify(doc.title) || doc.slug)} onSite={onSite} live={meta.live} siteOrigin={siteOrigin} />
            </section>
            <section className="space-y-3 border-t border-line pt-5">
              <h2 className="text-sm font-semibold text-text">Search and sharing</h2>
              <PostSeoFields seo={doc.seo} onChange={(seo) => set("seo", seo)} fallbackTitle={doc.title} fallbackDescription={doc.excerpt ?? ""} url={liveUrl} />
            </section>
            <section data-field-path="author" className="space-y-1 border-t border-line pt-5 text-sm">
              <h2 className="text-sm font-semibold text-text">Author and dates</h2>
              <p className="text-muted">
                Written by <span className="font-medium text-text">{post.author.name}</span>
                {post.author.id === me.id ? " (you)" : ""}.
              </p>
              <p data-field-path="publishAt" className="text-xs text-subtle">
                Created {formatIstDateTime(post.createdAt)}.{meta.publishAt ? ` ${meta.live ? "Live since" : "Goes live"} ${formatIstDateTime(meta.publishAt)}.` : ""}
              </p>
            </section>
          </IssueRoot>
        </fieldset>
      </div>
    </div>
  );

  const preview = (
    <PreviewFrame
      title={`Live preview of ${title}`}
      scrollTo={scrollTo}
      onSelectBlock={(id) => {
        setTab("content");
        setActiveId(id);
        setOpen(id, true);
        setReveal({ id });
      }}
      toolbar={
        <label className="inline-flex items-center gap-1.5 text-xs text-muted">
          <input type="checkbox" checked={showChrome} onChange={(e) => setShowChrome(e.target.checked)} className="h-3.5 w-3.5 accent-brand" />
          Header &amp; footer
        </label>
      }
    >
      <PreviewChrome ctx={ctx} year={year} show={showChrome}>
        <PreviewPostHeader
          title={deferred.title}
          excerpt={deferred.excerpt}
          tags={deferred.tags.map((t) => tagNames[t] ?? t)}
          author={post.author.name}
          dateLabel={dateLabel}
          cover={deferred.coverMediaId ? { src: `/media/${deferred.coverMediaId}`, alt: media[deferred.coverMediaId]?.alt ?? "" } : null}
        />
        <PreviewBlocks blocks={deferred.body} ctx={ctx} activeId={activeId} />
      </PreviewChrome>
    </PreviewFrame>
  );

  return (
    <EditorEnvProvider value={env}>
      <EditorShell header={header} banners={banners} edit={edit} preview={preview} />

      <PublishDialog state={scheduling} busy={busy} onChange={setScheduling} onCancel={() => setScheduling(null)} onConfirm={publish} dirty={editor.dirty} slug={meta.slug} />
      <ConfirmDialog
        open={confirm === "unpublish" || confirm === "archive"}
        onClose={() => setConfirm(null)}
        title={confirm === "unpublish" ? "Unpublish this post" : "Archive this post"}
        pending={busy}
        error={null}
        tone="danger"
        confirmLabel={confirm === "unpublish" ? "Unpublish" : "Archive"}
        onConfirm={() => {
          if (confirm === "unpublish") unpublish();
          else if (confirm === "archive") archive();
        }}
      >
        {confirm === "unpublish" && <p>{`/blog/${meta.slug} stops working at once and the post becomes a draft again.`}</p>}
        {confirm === "archive" && <p>The post comes off the site and out of the list. It can be restored until it is deleted.</p>}
      </ConfirmDialog>
      {confirm === "delete" && (
        <DeletePostDialog
          postId={post.id}
          slug={meta.slug}
          offerRedirect={meta.wasPublished && caps.publish}
          admin={me.role === "ADMIN"}
          siteHost={new URL(siteOrigin).host}
          onClose={() => setConfirm(null)}
          onDeleted={(message) => {
            pageNotice.show("success", message);
            router.push("/posts");
          }}
        />
      )}
      <ConflictDialog
        conflict={editor.conflict}
        what="post"
        busy={busy || editor.saving}
        onClose={editor.clearConflict}
        onReload={reloadTheirs}
        onOverwrite={() => void editor.save({ force: true }).then((ok) => ok && notice.show("success", "Your version is saved over theirs."))}
      />
      <LeaveDialog href={leaveTo} canSave={!readOnly && saveCheck.length === 0} busy={busy} onStay={() => setLeaveTo(null)} onLeave={() => leave(false)} onSaveAndLeave={() => leave(true)} />
      <MediaPicker open={!!picker} onClose={() => closePicker(null)} onPick={(row) => closePicker(row)} canUpload={caps.write} />
      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <UndoToast toast={toast} onDismiss={() => setToast(null)} />
    </EditorEnvProvider>
  );
}

function PublishDialog({
  state,
  busy,
  dirty,
  slug,
  onChange,
  onCancel,
  onConfirm,
}: {
  state: { mode: "now" | "later"; when: string } | null;
  busy: boolean;
  dirty: boolean;
  slug: string;
  onChange: (next: { mode: "now" | "later"; when: string }) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const whenId = useId();
  return (
    <Dialog open={!!state} onClose={() => !busy && onCancel()} title="Publish this post">
      {state && (
        <div className="space-y-4 text-sm">
          <fieldset className="space-y-2">
            <legend className="sr-only">When</legend>
            <label className="flex items-start gap-2">
              <input type="radio" name="publish-when" checked={state.mode === "now"} onChange={() => onChange({ ...state, mode: "now" })} className="mt-1 accent-brand" />
              <span>
                <span className="font-medium text-text">Now</span>
                <span className="block text-xs text-muted">{`It goes live at /blog/${slug} straight away.`}</span>
              </span>
            </label>
            <label className="flex items-start gap-2">
              <input type="radio" name="publish-when" checked={state.mode === "later"} onChange={() => onChange({ ...state, mode: "later" })} className="mt-1 accent-brand" />
              <span>
                <span className="font-medium text-text">At a set time</span>
                <span className="block text-xs text-muted">Scheduled: the site shows it from then on. A time in the past back-dates it.</span>
              </span>
            </label>
          </fieldset>
          {state.mode === "later" && (
            <div className="space-y-1.5 pl-6">
              <Label htmlFor={whenId}>Date and time (India time)</Label>
              <Input id={whenId} type="datetime-local" value={state.when} onChange={(e) => onChange({ ...state, when: e.target.value })} className="w-auto" />
            </div>
          )}
          {dirty && <p className="text-xs text-muted">Your unsaved changes are saved first.</p>}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
            <Button type="button" onClick={onConfirm} disabled={busy || (state.mode === "later" && !state.when)}>
              {busy && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
              {state.mode === "later" ? "Schedule" : "Publish now"}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function SlugField({
  value,
  onChange,
  onSuggest,
  onSite,
  live,
  siteOrigin,
}: {
  value: string;
  onChange: (next: string) => void;
  onSuggest: () => void;
  /** Published or scheduled: a new address takes effect on "Update post". */
  onSite: boolean;
  /** On the site now: the old address gets a 301 to the new one. */
  live: boolean;
  siteOrigin: string;
}) {
  const id = useId();
  const messages = useIssuesAt("slug");
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>Address</Label>
      <div className="flex items-center">
        <span aria-hidden="true" className="grid h-9 place-items-center rounded-l-base border border-r-0 border-line-strong bg-surface-sunken px-2.5 font-mono text-xs text-subtle">
          /blog/
        </span>
        <Input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value.toLowerCase().replace(/\s+/g, "-"))}
          spellCheck={false}
          autoCapitalize="off"
          aria-invalid={messages.length ? true : undefined}
          aria-describedby={`${id}-hint`}
          className="rounded-l-none font-mono text-[13px]"
        />
      </div>
      <p id={`${id}-hint`} className="text-xs text-subtle">
        {siteOrigin}/blog/{value || "…"}
        {" · "}
        <button type="button" onClick={onSuggest} className="font-medium text-brand hover:underline">
          Make it from the title
        </button>
      </p>
      {onSite && (
        <p className="text-xs text-warning">
          {live
            ? "The post is on the site: a new address takes effect when you update it, and a redirect from the old one is made for you, so links keep working."
            : "The post is scheduled: a new address takes effect when you update it."}
        </p>
      )}
      {messages.map((m, i) => (
        <p key={i} className="text-xs text-danger">
          {m}
        </p>
      ))}
    </div>
  );
}

type RedirectChoice = "blog" | "path" | "none";

/** What was typed as a place on the site ("pricing" is "/pricing"); an address with a scheme is left as it is. */
const asTarget = (raw: string) => {
  const t = raw.trim();
  return !t || t.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(t) ? t : `/${t}`;
};

/**
 * "Delete for good", for an archived post. When the post was ever on the site and the person may
 * publish, its old address can be sent on: to the blog (the default), to another address, or nowhere
 * (it then answers "not found"). The server checks the redirect before anything is deleted, and its
 * refusal — another site's address is an admin's to choose — is shown here.
 */
function DeletePostDialog({
  postId,
  slug,
  offerRedirect,
  admin,
  siteHost,
  onClose,
  onDeleted,
}: {
  postId: string;
  slug: string;
  offerRedirect: boolean;
  admin: boolean;
  siteHost: string;
  onClose: () => void;
  onDeleted: (message: string) => void;
}) {
  const pathId = useId();
  const choiceName = useId();
  const [choice, setChoice] = useState<RedirectChoice>("blog");
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startPending] = useTransition();
  const from = `/blog/${slug}`;
  const typed = asTarget(path);
  const checked = choice === "path" && typed ? normaliseTarget(typed, { ownHosts: [siteHost, `www.${siteHost}`] }) : null;
  const pathProblem = !checked
    ? null
    : !checked.ok
      ? checked.message
      : checked.splat
        ? "Give one address, without /* at the end."
        : checked.external && !admin
          ? "Only an admin can send visitors to another site."
          : checked.toUrl.split(/[?#]/)[0] === from
            ? "That is the post's own address."
            : null;
  const ready = !offerRedirect || choice !== "path" || (!!typed && !pathProblem);
  const redirectTo = !offerRedirect || choice === "none" ? null : choice === "blog" ? "" : typed;

  const confirm = () =>
    startPending(async () => {
      setError(null);
      try {
        const result = await cmsDeletePost(postId, { redirectTo });
        if (!result.ok) {
          setError(result.error);
          return;
        }
        const r = result.data.redirect;
        onDeleted(r ? `The post is deleted. Visitors to ${r.fromPath} now go to ${r.toUrl}.` : "The post is deleted.");
      } catch {
        setError("The post wasn't deleted — nothing changed. Try again.");
      }
    });

  const option = (value: RedirectChoice, title: string, detail: string) => (
    <label className="flex cursor-pointer items-start gap-2">
      <input type="radio" name={choiceName} value={value} checked={choice === value} onChange={() => setChoice(value)} disabled={pending} className="mt-1 accent-brand" />
      <span>
        <span className="font-medium text-text">{title}</span>
        <span className="block text-xs text-muted">{detail}</span>
      </span>
    </label>
  );

  return (
    <ConfirmDialog
      open
      onClose={onClose}
      title="Delete this post for good"
      pending={pending}
      error={error}
      tone="danger"
      confirmLabel="Delete for good"
      typed={slug}
      confirmDisabled={!ready}
      onConfirm={confirm}
    >
      <p>The post is deleted. This cannot be undone.</p>
      {offerRedirect && (
        <fieldset className="space-y-2">
          <legend className="mb-1 text-[13px] font-medium text-muted">{`It was on the site at ${from}. Anyone who follows an old link there:`}</legend>
          {option("blog", "Goes to the blog (/blog)", "Recommended: old links and search results still lead somewhere. A 301 redirect is added.")}
          {option("path", "Goes to another address", "A related post, or any page on this site. A 301 redirect is added.")}
          {choice === "path" && (
            <div className="space-y-1 pl-6">
              <Label htmlFor={pathId} className="sr-only">
                Where to send them
              </Label>
              <Input
                id={pathId}
                value={path}
                onChange={(e) => setPath(e.target.value.slice(0, 2000))}
                placeholder={admin ? "/blog/a-related-post or https://…" : "/blog/a-related-post"}
                spellCheck={false}
                autoCapitalize="off"
                autoComplete="off"
                readOnly={pending}
                aria-invalid={pathProblem ? true : undefined}
                aria-describedby={`${pathId}-hint`}
                className={cn("font-mono text-[13px]", pathProblem && "border-danger")}
              />
              <p id={`${pathId}-hint`} className={cn("text-xs", pathProblem ? "text-danger" : "text-subtle")}>
                {pathProblem ?? (admin ? "A path on this site, or another site's https:// address." : "A path on this site, like /blog/a-related-post.")}
              </p>
            </div>
          )}
          {option("none", "Finds nothing", "No redirect: the address answers “page not found”.")}
        </fieldset>
      )}
    </ConfirmDialog>
  );
}
