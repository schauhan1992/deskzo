"use client";

import { useDeferredValue, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronRight, Eye, History, LoaderCircle, Redo2, Send, Undo2 } from "lucide-react";
import {
  cmsArchivePage,
  cmsChangePageSlug,
  cmsDefaultPageDocument,
  cmsDeletePage,
  cmsGetPage,
  cmsPagePreviewLink,
  cmsPublishPage,
  cmsRestorePageVersion,
  cmsSavePageDraft,
  cmsUnarchivePage,
  cmsUnpublishPage,
} from "@/actions/cms/pages";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { RowMenu, type RowMenuItem } from "@/components/console/kit/row-menu";
import { BLOCK_TYPES, type SiteBlock, type SiteRenderContext } from "@/components/site/blocks/types";
import { fill as fillTokens } from "@/components/site/links";
import { BlockList } from "@/components/cms/editor/block-list";
import { BLOCK_INFO } from "@/components/cms/editor/catalog";
import { pagePublishIssues, pageTopCount, publishedPrint, publishNormalised } from "@/components/cms/editor/checks";
import { groupIssues, insertItem, mergeIssues, type FieldIssue } from "@/components/cms/editor/doc-utils";
import { PageStatusPill } from "@/components/cms/common/status";
import { ConflictDialog, EditorBanner, LeaveDialog, SaveState, ShortcutsDialog, UndoToast, useEditorNotice, type Toast } from "@/components/cms/editor/editor-chrome";
import { EditorEnvProvider, IssueRoot } from "@/components/cms/editor/editor-context";
import { EditorShell, PaneTabs } from "@/components/cms/editor/editor-shell";
import { TextField } from "@/components/cms/editor/fields";
import { HistoryPanel } from "@/components/cms/editor/history-panel";
import { PreviewBlocks, PreviewChrome } from "@/components/cms/editor/preview-blocks";
import { PreviewFrame } from "@/components/cms/editor/preview-frame";
import { PageSeoFields } from "@/components/cms/editor/seo-fields";
import { useAutosave, useBeforeUnload, useDraftEditor, useEditorKeys, useLinkGuard } from "@/components/cms/editor/use-draft-editor";
import { MediaPicker } from "@/components/cms/media/media-picker";
import { ActionNotice } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input, Label } from "@/components/ui/input";
import { CMS_ROUTES } from "@/lib/cms/nav";
import type { AutoRedirect, CmsCaps, CmsIssue, MediaRow, PageDetail, PageDocument, PageSaved, PageVersionRow } from "@/lib/cms/types";
import { checkPageDocument, PAGE_SLUG, stableJson } from "@/lib/cms/validate";
import { formatIstDateTime } from "@/lib/india-time";

/**
 * The page editor: the blocks on the left, the live preview on the right, and around them saving
 * (autosave every 30 seconds, Ctrl/⌘+S), publishing with a note, the signed preview link, history,
 * the page's settings and SEO, and what only publishers may do (unpublish, archive, delete, move).
 *
 * `pageRef` is the address's segment — a page id, or "builtin-<slug>" for one of the site's own
 * pages — and every action is called with it, before and after the first save alike, so the editor
 * never has to navigate (and lose what is being typed) when a built-in page gets its real id.
 */

export type PageEditorProps = {
  pageRef: string;
  page: PageDetail;
  caps: CmsCaps;
  ctx: SiteRenderContext;
  year: number;
  siteOrigin: string;
  sitePaths: string[];
  media: MediaRow[];
};

type Meta = {
  status: PageDetail["status"];
  archived: boolean;
  saved: boolean;
  slug: string;
  path: string;
  publishedAt: Date | null;
  publishedBy: string | null;
  publishedPrint: string | null;
};

type Confirm = "publish" | "unpublish" | "archive" | "delete" | "reset" | { restore: PageVersionRow } | null;

const pageFingerprint = (doc: PageDocument) => stableJson(doc);
const toFieldIssues = (issues: { path: string; message: string }[]): FieldIssue[] => issues.map((i) => ({ path: i.path, message: i.message }));

export function PageEditor({ pageRef, page, caps, ctx, year, siteOrigin, sitePaths, media: initialMedia }: PageEditorProps) {
  const router = useRouter();
  const notice = useEditorNotice();
  const [meta, setMeta] = useState<Meta>(() => ({
    status: page.status,
    archived: page.archived,
    saved: page.saved,
    slug: page.slug,
    path: page.path,
    publishedAt: page.publishedAt,
    publishedBy: page.publishedBy,
    publishedPrint: page.published ? publishedPrint(page.published) : null,
  }));
  const readOnly = !caps.write || meta.archived;
  const canPublish = caps.publish && !meta.archived;

  const editor = useDraftEditor<PageDocument, PageSaved>({
    initial: page.draft,
    initialVersion: page.version,
    initialSavedAt: page.updatedAt,
    fingerprint: pageFingerprint,
    canSave: !readOnly,
    send: (doc, version, force) => cmsSavePageDraft(pageRef, { document: doc, version, force }),
    onSaved: (data) => setMeta((m) => ({ ...m, status: data.status, saved: true })),
  });
  const doc = editor.doc;
  const deferred = useDeferredValue(doc);

  // ─── Media, the picker ─────────────────────────────────────────────────────────────────────────
  const [media, setMedia] = useState<Record<string, MediaRow>>(() => Object.fromEntries(initialMedia.map((m) => [m.id, m])));
  const [picker, setPicker] = useState<{ resolve: (row: MediaRow | null) => void } | null>(null);
  const env = useMemo(
    () => ({
      readOnly,
      sitePaths,
      media,
      pickImage: () => new Promise<MediaRow | null>((resolve) => setPicker({ resolve })),
    }),
    [readOnly, sitePaths, media],
  );
  const closePicker = (row: MediaRow | null) => {
    if (row) setMedia((m) => ({ ...m, [row.id]: row }));
    picker?.resolve(row);
    setPicker(null);
  };

  // ─── Checks and issues ─────────────────────────────────────────────────────────────────────────
  const draftCheck = useMemo(() => checkPageDocument(doc, "draft"), [doc]);
  const [publishCheck, setPublishCheck] = useState(false);
  const publishIssues = useMemo(() => (publishCheck ? pagePublishIssues(deferred, media, page.requiredBlock) : []), [publishCheck, deferred, media, page.requiredBlock]);
  const issues = useMemo(() => mergeIssues(draftCheck.ok ? [] : draftCheck.issues, publishIssues, editor.serverIssues), [draftCheck, publishIssues, editor.serverIssues]);
  const grouped = useMemo(() => groupIssues(issues, doc.blocks, "blocks"), [issues, doc.blocks]);
  const settingsIssues = grouped.document.filter((i) => i.path === "title" || i.path.startsWith("seo"));
  const listIssues = grouped.document.filter((i) => !(i.path === "title" || i.path.startsWith("seo")));
  const livePrint = useMemo(() => (meta.status === "PUBLISHED" ? publishedPrint(deferred) : null), [meta.status, deferred]);
  const changed = meta.status === "PUBLISHED" && livePrint !== meta.publishedPrint;

  useAutosave(editor, { enabled: !readOnly, blocked: !draftCheck.ok });
  useBeforeUnload((editor.dirty && !readOnly) || editor.saving);
  const [leaveTo, setLeaveTo] = useState<string | null>(null);
  useLinkGuard(editor.dirty && !readOnly, setLeaveTo);
  useEditorKeys({ onSave: () => void saveNow(), onUndo: editor.undo, onRedo: editor.redo });

  // ─── Which block is open, picked, shown ────────────────────────────────────────────────────────
  const [tab, setTab] = useState<"blocks" | "settings">("blocks");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(() => new Set(page.draft.blocks.length <= 2 ? page.draft.blocks.map((b) => b.id) : []));
  const [scrollTo, setScrollTo] = useState<{ id: string } | null>(null);
  const [reveal, setReveal] = useState<{ id: string } | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [showChrome, setShowChrome] = useState(true);
  const [signupOpen, setSignupOpen] = useState(ctx.signupOpen);
  const [viewing, setViewing] = useState<{ row: PageVersionRow; doc: PageDocument } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [slugInput, setSlugInput] = useState(page.slug);
  /** The 301 the last move of a published page left behind, for its banner. */
  const [moved, setMoved] = useState<AutoRedirect | null>(null);
  const [busy, startBusy] = useTransition();

  const setOpen = (id: string, open: boolean) =>
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });

  const updateBlocks = (fn: (blocks: SiteBlock[]) => SiteBlock[], key?: string) => editor.update((d) => ({ ...d, blocks: fn(d.blocks) }), key);

  const removeBlock = (block: SiteBlock, index: number) => {
    updateBlocks((list) => list.filter((b) => b.id !== block.id));
    if (activeId === block.id) setActiveId(null);
    setToast({ id: Date.now(), message: `Removed “${BLOCK_INFO[block.type]?.label ?? "block"}”.`, undo: () => updateBlocks((list) => (list.some((b) => b.id === block.id) ? list : insertItem(list, index, block))) });
  };

  const selectFromPreview = (id: string) => {
    setTab("blocks");
    setActiveId(id);
    setOpen(id, true);
    setReveal({ id });
  };

  const openFirstIssue = (list: CmsIssue[]) => {
    const withBlock = groupIssues(list, doc.blocks, "blocks");
    const first = doc.blocks.find((b) => withBlock.byBlock.has(b.id));
    if (first) {
      setTab("blocks");
      setOpen(first.id, true);
      setActiveId(first.id);
      setReveal({ id: first.id });
    } else if (withBlock.document.some((i) => i.path === "title" || i.path.startsWith("seo"))) setTab("settings");
  };

  // ─── Saving, publishing and the rest ───────────────────────────────────────────────────────────
  async function saveNow() {
    if (readOnly) return;
    if (!draftCheck.ok) {
      notice.show("error", `Fix ${draftCheck.issues.length === 1 ? "the highlighted field" : `the ${draftCheck.issues.length} highlighted fields`} first — the draft can't be saved with them.`);
      openFirstIssue(draftCheck.issues);
      return;
    }
    const ok = await editor.save();
    if (ok) notice.show("success", "Draft saved.");
  }

  const askPublish = () => {
    const problems = pagePublishIssues(doc, media, page.requiredBlock);
    setPublishCheck(true);
    if (problems.length) {
      notice.show("error", `${problems.length === 1 ? "One field needs" : `${problems.length} fields need`} attention before this can be published.`);
      openFirstIssue(problems);
      return;
    }
    setConfirm("publish");
  };

  const publish = (note: string) =>
    startBusy(async () => {
      try {
        const result = await cmsPublishPage(pageRef, { document: doc, version: editor.version, note });
        if (!result.ok) {
          setConfirm(null);
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
        const normal = publishNormalised(doc) ?? doc;
        if (stableJson(normal) === stableJson(doc)) editor.markSaved(doc, result.data.version);
        else editor.load(normal, result.data.version);
        setMeta((m) => ({ ...m, status: "PUBLISHED", saved: true, publishedAt: result.data.publishedAt, publishedPrint: publishedPrint(normal) }));
        setPublishCheck(false);
        setConfirm(null);
        notice.show("success", `Published — ${meta.path} shows it now.`);
      } catch {
        notice.show("error", "Publishing didn't finish. Nothing may have changed — try again.");
        setConfirm(null);
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
      () => cmsUnpublishPage(pageRef),
      () => {
        setMeta((m) => ({ ...m, status: "DRAFT", publishedAt: null, publishedBy: null, publishedPrint: null }));
        notice.show("success", `Unpublished — ${meta.path} is no longer on the site.`);
      },
    );

  const archive = () =>
    simple(
      () => cmsArchivePage(pageRef),
      () => {
        setMeta((m) => ({ ...m, archived: true, status: "DRAFT", publishedAt: null, publishedPrint: null }));
        notice.show("success", "Archived — the page is off the site and out of the list.");
      },
    );

  const unarchive = () =>
    simple(
      () => cmsUnarchivePage(pageRef),
      () => {
        setMeta((m) => ({ ...m, archived: false }));
        notice.show("success", "Restored from the archive, as a draft.");
      },
    );

  const remove = () =>
    simple(
      () => cmsDeletePage(pageRef),
      () => router.push("/pages"),
    );

  const resetToDefault = () =>
    startBusy(async () => {
      try {
        const result = await cmsDefaultPageDocument(meta.slug);
        setConfirm(null);
        if (!result.ok || !result.data) {
          notice.show("error", result.ok ? "This page has no default content." : result.error);
          return;
        }
        editor.replace(result.data);
        notice.show("info", "The default content is in the editor. Save or publish to keep it — Undo brings back what was there.");
      } catch {
        setConfirm(null);
        notice.show("error", "The default content didn't load. Try again.");
      }
    });

  const restore = (row: PageVersionRow) =>
    startBusy(async () => {
      try {
        const result = await cmsRestorePageVersion(pageRef, row.id, { version: editor.version || undefined });
        if (!result.ok) {
          setConfirm(null);
          if (result.conflict) editor.raiseConflict(result.conflict);
          else notice.show("error", result.error);
          return;
        }
        const fresh = await cmsGetPage(pageRef);
        setConfirm(null);
        if (!fresh.ok) {
          notice.show("error", fresh.error);
          return;
        }
        editor.load(fresh.data.draft, fresh.data.version);
        setMeta((m) => ({ ...m, status: fresh.data.status, saved: true }));
        setViewing(null);
        setHistoryOpen(false);
        notice.show("success", `The version from ${formatIstDateTime(row.createdAt)} is now the draft. Publish it to put it on the site; Undo brings back what was there.`);
      } catch {
        setConfirm(null);
        notice.show("error", "Restoring didn't finish. Try again.");
      }
    });

  const reloadTheirs = () =>
    startBusy(async () => {
      try {
        const fresh = await cmsGetPage(pageRef);
        if (!fresh.ok) {
          notice.show("error", fresh.error);
          return;
        }
        editor.load(fresh.data.draft, fresh.data.version);
        setMeta((m) => ({
          ...m,
          status: fresh.data.status,
          saved: fresh.data.saved,
          publishedAt: fresh.data.publishedAt,
          publishedPrint: fresh.data.published ? publishedPrint(fresh.data.published) : null,
        }));
        notice.show("info", "Their version is loaded. Yours is one Undo away (Ctrl/⌘+Z) if you need anything from it.");
      } catch {
        notice.show("error", "Their version didn't load. Try again.");
      }
    });

  const changeSlug = () =>
    startBusy(async () => {
      try {
        const result = await cmsChangePageSlug(pageRef, slugInput);
        if (!result.ok) {
          notice.show("error", result.error);
          return;
        }
        const oldPath = meta.path;
        setMeta((m) => ({ ...m, slug: result.data.slug, path: `/${result.data.slug}` }));
        setSlugInput(result.data.slug);
        const redirect = result.data.redirect;
        if (redirect) setMoved(redirect);
        notice.show(
          "success",
          redirect
            ? `The page is at /${result.data.slug} now. A redirect was created from ${redirect.from}, so old links still work.`
            : meta.status === "PUBLISHED"
              ? `The page is at /${result.data.slug} now. No redirect could be made from ${oldPath} — update any links to it, or add one in Redirects.`
              : `The page is at /${result.data.slug} now.`,
        );
      } catch {
        notice.show("error", "The address didn't change. Try again.");
      }
    });

  const openPreviewTab = () => {
    // Opened now, inside the click, so a popup blocker lets it through; pointed at the link once there is one.
    const win = window.open("about:blank", "_blank");
    startBusy(async () => {
      try {
        if (editor.dirty && !readOnly) {
          if (!draftCheck.ok || !(await editor.save())) {
            win?.close();
            notice.show("error", "Save the draft first — the preview shows the saved draft.");
            return;
          }
        }
        const result = await cmsPagePreviewLink(pageRef);
        if (!result.ok) {
          win?.close();
          notice.show("error", result.error);
          return;
        }
        if (win) {
          win.opener = null;
          win.location.href = result.data.url;
          notice.show("info", "The preview opened in a new tab. Its link works for 15 minutes.");
        } else {
          notice.show("info", `Your browser blocked the new tab. Open the preview here: ${result.data.url}`);
        }
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
      if (save && !(await editor.save())) {
        setLeaveTo(null);
        notice.show("error", "The draft didn't save, so you're still here.");
        return;
      }
      setLeaveTo(null);
      router.push(href);
    });

  // ─── The page ──────────────────────────────────────────────────────────────────────────────────
  const title = doc.title.trim() || "Untitled page";
  const previewCtx = useMemo(() => ({ ...ctx, signupOpen }), [ctx, signupOpen]);
  const fill = (text: string) => fillTokens(text, ctx);
  const topCount = pageTopCount(doc.blocks);
  const liveUrl = `${siteOrigin}${meta.path}`;

  const menu: RowMenuItem[] = [
    ...(meta.status === "PUBLISHED" && !meta.archived ? [{ key: "view", label: "View on the site", href: liveUrl, external: true }] : []),
    { key: "shortcuts", label: "Keyboard shortcuts", onSelect: () => setShortcutsOpen(true) },
    ...(page.builtin && caps.write && !meta.archived ? [{ key: "sep1", separator: true as const }, { key: "reset", label: "Reset to the default content…", onSelect: () => setConfirm("reset") }] : []),
    ...(canPublish && !page.builtin
      ? [
          { key: "sep2", separator: true as const },
          ...(meta.status === "PUBLISHED" ? [{ key: "unpublish", label: "Unpublish…", onSelect: () => setConfirm("unpublish") }] : []),
          { key: "archive", label: "Archive…", onSelect: () => setConfirm("archive"), danger: true },
        ]
      : []),
    ...(caps.publish && page.builtin ? [{ key: "sep3", separator: true as const }, { key: "why", label: "Built-in pages can't be unpublished or deleted", disabled: true }] : []),
    ...(caps.publish && meta.archived ? [{ key: "sep4", separator: true as const }, { key: "unarchive", label: "Restore from the archive", onSelect: unarchive }, { key: "delete", label: "Delete for good…", onSelect: () => setConfirm("delete"), danger: true }] : []),
  ];

  const header = (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="min-w-0 flex-1">
        <nav aria-label="Breadcrumb">
          <ol className="flex items-center gap-1 text-xs text-muted">
            <li>
              <Link href="/pages" className="hover:text-text">
                Pages
              </Link>
            </li>
            <li aria-hidden="true">
              <ChevronRight className="h-3 w-3" />
            </li>
            <li className="truncate font-mono">{meta.path}</li>
          </ol>
        </nav>
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-2">
          <h1 className="truncate text-lg font-semibold tracking-tight text-text">{title}</h1>
          <PageStatusPill status={meta.status} changed={changed} archived={meta.archived} />
        </div>
      </div>
      <SaveState
        saving={editor.saving}
        dirty={editor.dirty}
        blocked={draftCheck.ok ? 0 : draftCheck.issues.length}
        conflict={!!editor.conflict}
        failure={editor.failure}
        autosave={!readOnly}
        lastSavedAt={editor.lastSavedAt}
        neverSaved={meta.saved ? null : "Built-in content · not saved yet"}
        readOnly={readOnly}
      />
      <div className="flex flex-wrap items-center gap-1.5">
        {!readOnly && (
          <>
            <IconButton icon={Undo2} label="Undo (Ctrl+Z)" onClick={editor.undo} disabled={!editor.canUndo} />
            <IconButton icon={Redo2} label="Redo (Ctrl+Shift+Z)" onClick={editor.redo} disabled={!editor.canRedo} />
          </>
        )}
        <Button type="button" variant="ghost" size="sm" onClick={() => setHistoryOpen(true)}>
          <History aria-hidden="true" className="h-4 w-4" />
          History
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={openPreviewTab} disabled={busy}>
          <Eye aria-hidden="true" className="h-4 w-4" />
          Preview
        </Button>
        {!readOnly && (
          <Button type="button" variant={canPublish ? "secondary" : "primary"} size="sm" onClick={() => void saveNow()} disabled={editor.saving} aria-keyshortcuts="Control+S">
            {editor.saving && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
            Save draft
          </Button>
        )}
        {canPublish && (
          <Button type="button" size="sm" onClick={askPublish} disabled={busy || editor.saving}>
            <Send aria-hidden="true" className="h-4 w-4" />
            Publish
          </Button>
        )}
        <RowMenu label="More page actions" items={menu} />
      </div>
    </div>
  );

  const banners = (
    <>
      <div aria-live="polite">{notice.notice && <ActionNotice tone={notice.notice.tone}>{notice.notice.message}</ActionNotice>}</div>
      {meta.archived && (
        <EditorBanner
          tone="warning"
          title="This page is archived"
          action={
            caps.publish ? (
              <>
                <Button type="button" variant="secondary" size="sm" onClick={unarchive} disabled={busy}>
                  Restore
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setConfirm("delete")} className="text-danger">
                  Delete for good…
                </Button>
              </>
            ) : undefined
          }
        >
          It is off the site and out of the pages list. Restore it to change or publish it again.
        </EditorBanner>
      )}
      {!caps.write && <EditorBanner tone="info" title="You can look, not change">Your role reads the CMS. Ask an editor to make changes.</EditorBanner>}
      {caps.write && !caps.publish && !meta.archived && <EditorBanner tone="info" title="Your changes are saved as a draft">An editor or admin publishes them to the site.</EditorBanner>}
      {meta.status === "DEFAULT" && !meta.archived && (
        <EditorBanner tone="info" title="This is the site's built-in content">
          The site shows it until this page is published from here. Change anything, then save or publish. “Reset to the default content” brings it back later.
        </EditorBanner>
      )}
      {editor.failure && !editor.serverIssues.length && (
        <EditorBanner tone="danger" title="The draft didn't save" action={!readOnly ? <Button type="button" size="sm" variant="secondary" onClick={() => void editor.save()}>Try again</Button> : undefined}>
          {editor.failure}
        </EditorBanner>
      )}
      {editor.serverIssues.length > 0 && (
        <EditorBanner tone="danger" title={editor.failure ?? "Some fields need attention"}>
          The fields are marked below{grouped.document.length ? `, and ${grouped.document.length === 1 ? "one is" : "some are"} in Page settings` : ""}.
        </EditorBanner>
      )}
      {moved && (
        <EditorBanner
          tone="success"
          title={`A redirect was created from ${moved.from}`}
          action={
            <Button type="button" variant="ghost" size="sm" onClick={() => setMoved(null)}>
              Dismiss
            </Button>
          }
        >
          {`Anyone who asks for ${moved.from} — an old link, a search engine — is sent to ${moved.to} (301, permanent)${moved.created ? "" : "; the redirect that was already there is updated"}. `}
          <Link href={CMS_ROUTES.redirects} className="font-medium underline">
            See the redirects
          </Link>
        </EditorBanner>
      )}
      {publishCheck && publishIssues.length > 0 && !editor.serverIssues.length && (
        <EditorBanner tone="warning" title={`${publishIssues.length === 1 ? "One field needs" : `${publishIssues.length} fields need`} attention before publishing`} action={<Button type="button" variant="ghost" size="sm" onClick={() => setPublishCheck(false)}>Hide</Button>}>
          They are marked in red. Drafts can be saved as they are.
        </EditorBanner>
      )}
      {topCount > 1 && <EditorBanner tone="warning" title="This page has more than one main title">A page should start with one hero or one page header — each is the page&apos;s h1.</EditorBanner>}
      {viewing && (
        <EditorBanner
          tone="info"
          title={`The preview shows the version from ${formatIstDateTime(viewing.row.createdAt)}`}
          action={
            <>
              {caps.write && !meta.archived && (
                <Button type="button" size="sm" variant="secondary" onClick={() => setConfirm({ restore: viewing.row })}>
                  Restore into draft
                </Button>
              )}
              <Button type="button" size="sm" variant="ghost" onClick={() => setViewing(null)}>
                Back to the draft
              </Button>
            </>
          }
        >
          {viewing.row.note ? `“${viewing.row.note}” — ` : ""}by {viewing.row.createdBy}. The editor still holds your draft.
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
          { key: "blocks", label: "Blocks", badge: issues.length - settingsIssues.length || undefined },
          { key: "settings", label: "Page settings & SEO", badge: settingsIssues.length || undefined },
        ]}
      />
      <div hidden={tab !== "blocks"}>
        {listIssues.length > 0 && (
          <div className="mb-3 space-y-1">
            {listIssues.map((i, n) => (
              <p key={n} role="alert" className="rounded-md border border-danger/30 bg-danger-bg px-3 py-2 text-xs text-danger">
                {i.message}
              </p>
            ))}
          </div>
        )}
        <BlockList
          blocks={doc.blocks}
          allowed={BLOCK_TYPES}
          requiredBlock={page.requiredBlock}
          issues={grouped.byBlock}
          activeId={activeId}
          openIds={openIds}
          reveal={reveal}
          readOnly={readOnly}
          onOpenChange={setOpen}
          onOpenAll={(open) => setOpenIds(new Set(open ? doc.blocks.map((b) => b.id) : []))}
          onActivate={(id) => {
            setActiveId(id);
            setScrollTo({ id });
          }}
          onBlocksChange={updateBlocks}
          onRemove={removeBlock}
        />
      </div>
      <fieldset hidden={tab !== "settings"} disabled={readOnly} className="min-w-0 space-y-6">
        <legend className="sr-only">Page settings and SEO</legend>
        <IssueRoot issues={toFieldIssues(settingsIssues)}>
          <section className="space-y-4">
            <h2 className="text-sm font-semibold text-text">The page</h2>
            <TextField label="Page name" name="title" value={doc.title} onChange={(value) => editor.update((d) => ({ ...d, title: value }), "title")} max={120} required hint="What the CMS calls it, in lists. Visitors see the SEO title below." />
            <SlugSection
              builtin={page.builtin}
              path={meta.path}
              canMove={caps.publish && !page.builtin && !meta.archived}
              value={slugInput}
              onChange={setSlugInput}
              onMove={changeSlug}
              busy={busy}
              current={meta.slug}
              published={meta.status === "PUBLISHED"}
              siteOrigin={siteOrigin}
            />
          </section>
          <section className="space-y-4 border-t border-line pt-6">
            <h2 className="text-sm font-semibold text-text">Search and sharing</h2>
            <PageSeoFields seo={doc.seo} onChange={(seo) => editor.update((d) => ({ ...d, seo }), "seo")} titleTemplate={ctx.settings.seo.titleTemplate} url={liveUrl} fill={fill} />
          </section>
          <section className="space-y-1 border-t border-line pt-6 text-xs text-muted">
            <p>{page.createdAt ? `Created ${formatIstDateTime(page.createdAt)}${page.createdBy ? ` by ${page.createdBy}` : ""}.` : "Built into the site."}</p>
            {meta.publishedAt && <p>{`Last published ${formatIstDateTime(meta.publishedAt)}${meta.publishedBy ? ` by ${meta.publishedBy}` : ""}.`}</p>}
          </section>
        </IssueRoot>
      </fieldset>
    </div>
  );

  const previewBlocks = viewing ? viewing.doc.blocks : deferred.blocks;
  const preview = (
    <PreviewFrame
      title={`Live preview of ${title}`}
      scrollTo={scrollTo}
      onSelectBlock={viewing ? () => undefined : selectFromPreview}
      toolbar={
        <>
          <label className="inline-flex items-center gap-1.5 text-xs text-muted">
            <input type="checkbox" checked={showChrome} onChange={(e) => setShowChrome(e.target.checked)} className="h-3.5 w-3.5 accent-brand" />
            Header &amp; footer
          </label>
          <label className="inline-flex items-center gap-1.5 text-xs text-muted">
            <span className="hidden xl:inline">Signup</span>
            <select value={signupOpen ? "open" : "invite"} onChange={(e) => setSignupOpen(e.target.value === "open")} aria-label="Preview signup as" className="h-7 rounded-base border border-line-strong bg-surface px-1.5 text-xs text-text">
              <option value="open">Open</option>
              <option value="invite">Invitation only</option>
            </select>
          </label>
        </>
      }
    >
      <PreviewChrome ctx={previewCtx} year={year} show={showChrome}>
        <PreviewBlocks blocks={previewBlocks} ctx={previewCtx} activeId={viewing ? null : activeId} />
      </PreviewChrome>
    </PreviewFrame>
  );

  const confirmTitle = confirm === "publish" ? "Publish this page" : confirm === "unpublish" ? "Unpublish this page" : confirm === "archive" ? "Archive this page" : confirm === "delete" ? "Delete this page for good" : confirm === "reset" ? "Reset to the default content" : "Restore this version into the draft";

  return (
    <EditorEnvProvider value={env}>
      <EditorShell header={header} banners={banners} edit={edit} preview={preview} />

      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirmTitle}
        pending={busy}
        error={null}
        tone={confirm === "delete" || confirm === "archive" || confirm === "unpublish" ? "danger" : "primary"}
        confirmLabel={confirm === "publish" ? "Publish" : confirm === "unpublish" ? "Unpublish" : confirm === "archive" ? "Archive" : confirm === "delete" ? "Delete for good" : confirm === "reset" ? "Load the default content" : "Restore into draft"}
        reason={confirm === "publish" ? { label: "A note for the history (optional)", minLength: 0, maxLength: 200, placeholder: "What changed" } : undefined}
        typed={confirm === "delete" ? meta.slug : undefined}
        onConfirm={({ reason }) => {
          if (confirm === "publish") publish(reason);
          else if (confirm === "unpublish") unpublish();
          else if (confirm === "archive") archive();
          else if (confirm === "delete") remove();
          else if (confirm === "reset") resetToDefault();
          else if (confirm && typeof confirm === "object") restore(confirm.restore);
        }}
      >
        {confirm === "publish" && (
          <p>
            What is in the editor goes on the site at <span className="font-mono">{meta.path}</span> straight away, and is kept in the history.
            {editor.dirty ? " Your unsaved changes are included." : ""}
          </p>
        )}
        {confirm === "unpublish" && <p>{`${meta.path} stops working at once and the page goes back to being a draft. Links to it will find the site's “not found” page.`}</p>}
        {confirm === "archive" && <p>The page comes off the site and out of the list. Its content and history are kept, and it can be restored until it is deleted.</p>}
        {confirm === "delete" && <p>The page and every version of it are deleted. This cannot be undone.</p>}
        {confirm === "reset" && <p>The site&apos;s built-in content for this page replaces what is in the editor. Nothing is saved until you save or publish, and Undo brings back what was there.</p>}
        {confirm && typeof confirm === "object" && (
          <p>
            The version from {formatIstDateTime(confirm.restore.createdAt)} becomes the draft. The site doesn&apos;t change until it is published.{editor.dirty ? " Your unsaved changes stay one Undo away." : ""}
          </p>
        )}
      </ConfirmDialog>

      <ConflictDialog
        conflict={editor.conflict}
        what="page"
        busy={busy || editor.saving}
        onClose={editor.clearConflict}
        onReload={reloadTheirs}
        onOverwrite={() => void editor.save({ force: true }).then((ok) => ok && notice.show("success", "Your version is saved over theirs."))}
      />
      <LeaveDialog href={leaveTo} canSave={!readOnly && draftCheck.ok} busy={busy} onStay={() => setLeaveTo(null)} onLeave={() => leave(false)} onSaveAndLeave={() => leave(true)} />
      <HistoryPanel
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        pageRef={pageRef}
        canWrite={caps.write && !meta.archived}
        saved={meta.saved}
        onBeforeCheckpoint={async () => (editor.dirty ? draftCheck.ok && (await editor.save()) : true)}
        onView={(row, versionDoc) => {
          setViewing({ row, doc: versionDoc });
          setHistoryOpen(false);
        }}
        onRestore={(row) => {
          setHistoryOpen(false);
          setConfirm({ restore: row });
        }}
      />
      <MediaPicker open={!!picker} onClose={() => closePicker(null)} onPick={(row) => closePicker(row)} canUpload={caps.write} />
      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <UndoToast toast={toast} onDismiss={() => setToast(null)} />
    </EditorEnvProvider>
  );
}

function SlugSection({
  builtin,
  path,
  canMove,
  value,
  onChange,
  onMove,
  busy,
  current,
  published,
  siteOrigin,
}: {
  builtin: boolean;
  path: string;
  canMove: boolean;
  value: string;
  onChange: (next: string) => void;
  onMove: () => void;
  busy: boolean;
  current: string;
  /** On the site now: moving it leaves a 301 from the old address. */
  published: boolean;
  siteOrigin: string;
}) {
  const clean = value.trim().toLowerCase().replace(/^\/+|\/+$/g, "");
  const valid = PAGE_SLUG.test(clean) && clean.length <= 120;
  if (builtin || !canMove) {
    return (
      <div className="space-y-1">
        <p className="text-[13px] font-medium text-muted">Address</p>
        <p className="font-mono text-sm text-text">
          {siteOrigin}
          {path}
        </p>
        <p className="text-xs text-subtle">{builtin ? "One of the site's own pages — its address is fixed." : "Editors and admins can move a page to another address."}</p>
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      <Label htmlFor="page-slug">Address</Label>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center">
          <span aria-hidden="true" className="grid h-9 place-items-center rounded-l-base border border-r-0 border-line-strong bg-surface-sunken px-2.5 font-mono text-xs text-subtle">
            /
          </span>
          <Input id="page-slug" value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={!valid || undefined} aria-describedby="page-slug-hint" className="rounded-l-none font-mono text-[13px]" spellCheck={false} autoCapitalize="off" />
        </div>
        <Button type="button" variant="secondary" size="sm" onClick={onMove} disabled={busy || !valid || clean === current}>
          Move the page
        </Button>
      </div>
      <p id="page-slug-hint" className={!valid ? "text-xs text-danger" : "text-xs text-subtle"}>
        {!valid
          ? "Lower-case words and hyphens, with / between levels — like about or solutions/retail."
          : published
            ? "Moving it takes effect at once, and a redirect from the old address is made for you — old links keep working."
            : "Moving it takes effect at once."}
      </p>
    </div>
  );
}
