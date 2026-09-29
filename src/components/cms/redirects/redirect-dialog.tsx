"use client";

import { useEffect, useEffectEvent, useId, useRef, useState, type FormEvent } from "react";
import { CircleCheck, EyeOff, Info, LoaderCircle, Plus, TriangleAlert } from "lucide-react";
import { cmsCheckRedirect, cmsCreateRedirect, cmsUpdateRedirect } from "@/actions/cms/redirects";
import { TextAreaField, TextField } from "@/components/cms/common/fields";
import { issuesByPath, useCmsAction } from "@/components/cms/common/use-cms-action";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Label, Select } from "@/components/ui/input";
import { checkRedirectShape, REDIRECT_NOTE_MAX, REDIRECT_PATH_MAX } from "@/lib/cms/redirect-rules";
import { MAX_REDIRECTS, REDIRECT_STATUSES, type CmsIssue, type LiveAddress, type RedirectCheck, type RedirectCovers, type RedirectInput, type RedirectRow, type RedirectStatus, type SiteRedirectMatch } from "@/lib/cms/types";
import { cn } from "@/lib/utils";

/**
 * Adding or changing one redirect: the old address, whether it is that address alone or everything
 * under it, where it goes, the status, a note, on or off.
 *
 * Two layers of checking, both as you type. The rules that need no database run in the browser at
 * once — the same functions the server uses (src/lib/cms/redirect-rules.ts): the address keyed as it
 * will be stored, the site's own pages refused, only https:// for another site. What needs the
 * database — another redirect from the same address, loops, chains, the 5,000 limit — is asked of
 * the server a moment after typing stops (cmsCheckRedirect), and nothing is saved until Save.
 *
 * The server also says which pages, posts and archives on the site now the redirect would take over
 * (src/lib/cms/redirect-covers.ts). That is allowed, but they can no longer be reached and leave the
 * sitemap, so the dialog warns — and points at moving a page or post from its editor instead, which
 * leaves the redirect by itself.
 *
 * Another site's address is an admin's to choose (a redirect from our domain to an outside one is a
 * phishing risk): an editor adding one is told so at once, and an editor opening one can change only
 * its note, or switch it off.
 */

export const STATUS_LABELS: Record<RedirectStatus, { short: string; long: string }> = {
  301: { short: "301 · Permanent", long: "301 — moved for good. The usual choice: search engines move the old address's standing to the new one." },
  308: { short: "308 · Permanent", long: "308 — moved for good, and a form sent to the old address is sent on as it was." },
  302: { short: "302 · Temporary", long: "302 — moved for now. Search engines keep the old address." },
  307: { short: "307 · Temporary", long: "307 — moved for now, and a form sent to the old address is sent on as it was." },
};

type Draft = { from: string; to: string; match: SiteRedirectMatch; status: RedirectStatus; note: string; enabled: boolean };

const draftOf = (row: RedirectRow | null, preset?: Partial<Draft>): Draft => ({
  from: row?.fromPath ?? "",
  to: row?.toUrl ?? "",
  match: row?.match ?? "EXACT",
  status: row?.status ?? 301,
  note: row?.note ?? "",
  enabled: row?.enabled ?? true,
  ...preset,
});

const inputOf = (d: Draft): RedirectInput => ({ from: d.from, to: d.to, match: d.match, status: d.status, note: d.note.trim() || null, enabled: d.enabled });
const keyOf = (d: Draft) => JSON.stringify(inputOf(d));
const ADMIN_ONLY = "Only an admin can send visitors to another site: a redirect from our address to an outside one is a phishing risk.";

/** "the post “Pricing tips” (/blog/pricing-tips)" — one live address, as the warning names it. */
function liveLabel(a: LiveAddress): string {
  const what =
    a.kind === "page"
      ? `the page “${a.title}”`
      : a.kind === "post"
        ? `the post “${a.title}”`
        : a.kind === "blog"
          ? "the blog's front page"
          : `the “${a.title}” ${a.kind} page`;
  return `${what} (${a.path})`;
}

/** What the redirect would take over, in a sentence: the one live address, or how many and the first few. */
function coversSentence(c: RedirectCovers, to: string): string {
  if (c.total === 1) return `This takes over ${liveLabel(c.examples[0])}, which is on the site now. Once it's on, visitors go to ${to} instead and can't reach it, and it leaves the sitemap.`;
  const more = c.total - c.examples.length;
  const named = c.examples.map(liveLabel).join(", ") + (more > 0 ? ` and ${more.toLocaleString("en-IN")} more` : "");
  return `This takes over ${c.total.toLocaleString("en-IN")} addresses that are on the site now: ${named}. Once it's on, visitors can't reach them, and they leave the sitemap.`;
}

export function RedirectDialog({
  row,
  admin,
  siteHost,
  used,
  preset,
  onClose,
}: {
  /** The one being changed; null to add one. */
  row: RedirectRow | null;
  admin: boolean;
  /** The public site's host — an https:// address on it is stored as a path. */
  siteHost: string;
  /** How many redirects there are, of the 5,000 allowed. */
  used: number;
  /** Fields to start from ("Point it straight at …" fills the target). */
  preset?: Partial<Draft>;
  onClose: () => void;
}) {
  const action = useCmsAction<RedirectRow>();
  const ownHosts = [siteHost, `www.${siteHost}`];
  const [draft, setDraft] = useState<Draft>(() => draftOf(row, preset));
  const [tried, setTried] = useState(false);
  const [remote, setRemote] = useState<{ key: string; check: RedirectCheck | null; failed: boolean } | null>(null);
  // A redirect opened for editing (or with a preset target) is checked once straight away, so its chain shows.
  const [checking, setChecking] = useState(() => !!(row || preset) && checkRedirectShape(inputOf(draftOf(row, preset)), { ownHosts }).ok);
  const timer = useRef<number | undefined>(undefined);
  const ticket = useRef(0);
  const fromRef = useRef<HTMLInputElement>(null);
  const noteId = useId();
  const statusId = useId();
  const matchName = useId();
  const locked = !!row && row.external && !admin;

  /** Asks the server about loops, chains, duplicates and the limit after `delay` — the newest question only; the answer lands when it arrives. */
  function schedule(next: Draft, delay: number) {
    window.clearTimeout(timer.current);
    const key = keyOf(next);
    const mine = ++ticket.current;
    timer.current = window.setTimeout(() => {
      cmsCheckRedirect(inputOf(next), row?.id ?? null).then(
        (r) => {
          if (mine !== ticket.current) return;
          setChecking(false);
          setRemote(r.ok ? { key, check: r.data, failed: false } : { key, check: null, failed: true });
        },
        () => {
          if (mine !== ticket.current) return;
          setChecking(false);
          setRemote({ key, check: null, failed: true });
        },
      );
    }, delay);
  }

  const onOpen = useEffectEvent(() => {
    // An editor on another site's redirect can change only the note, so that is where the typing starts.
    if (locked) document.getElementById(noteId)?.focus();
    else fromRef.current?.focus();
    if (checking) schedule(draft, 0);
  });

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => onOpen());
    const pending = timer;
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(pending.current);
    };
  }, []);

  function update(patch: Partial<Draft>) {
    const next = { ...draft, ...patch };
    setDraft(next);
    if (checkRedirectShape(inputOf(next), { ownHosts }).ok) {
      setChecking(true);
      schedule(next, 450);
    } else {
      // Nothing worth asking the server yet: drop any question in flight.
      window.clearTimeout(timer.current);
      ticket.current += 1;
      setChecking(false);
    }
  }

  // ─── What is wrong, as you type ────────────────────────────────────────────────────────────────
  const input = inputOf(draft);
  const shape = checkRedirectShape(input, { ownHosts });
  const local: CmsIssue[] = [...shape.issues];
  if (shape.value.external && !admin && !locked) local.push({ path: "to", message: ADMIN_ONLY });
  const fresh = remote && remote.key === keyOf(draft) ? remote : null;
  const serverCheck = fresh?.check ?? null;
  const shown = issuesByPath([...(tried || row ? local : local.filter((i) => (i.path === "from" ? draft.from.trim() : i.path === "to" ? draft.to.trim() : true))), ...(serverCheck?.issues ?? []), ...action.issues]);
  const general = serverCheck?.issues.find((i) => i.path === "")?.message ?? null;
  const chain = serverCheck?.chain ?? null;
  const covers = serverCheck?.covers ?? null;
  const normal = shape.ok ? shape.value : null;
  const unchanged = !!row && keyOf(draft) === keyOf(draftOf(row));
  const blocked = local.length > 0 || (serverCheck ? !serverCheck.ok : false);
  const close = () => {
    if (!action.pending) onClose();
  };

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setTried(true);
    if (action.pending || local.length > 0 || (serverCheck && !serverCheck.ok)) return;
    const done = (saved: RedirectRow) => `${row ? "Saved" : "Added"} the redirect ${saved.fromPath} → ${saved.toUrl}${saved.enabled ? "" : " (switched off)"}.`;
    if (!row) {
      action.run(() => cmsCreateRedirect(input), { success: done, onDone: onClose });
      return;
    }
    // Only what changed: an editor's note on another site's redirect must not resend its target.
    const before = draftOf(row);
    const changes: Partial<RedirectInput> = {};
    if (!locked) {
      if (normal?.fromPath !== row.fromPath || draft.match !== before.match) {
        changes.from = draft.from;
        changes.match = draft.match;
      }
      if (normal?.toUrl !== row.toUrl) changes.to = draft.to;
      if (draft.status !== before.status) changes.status = draft.status;
    }
    if ((draft.note.trim() || null) !== (row.note ?? null)) changes.note = draft.note.trim() || null;
    if (draft.enabled !== row.enabled) changes.enabled = draft.enabled;
    if (!Object.keys(changes).length) {
      onClose();
      return;
    }
    action.run(() => cmsUpdateRedirect(row.id, changes), { success: done, onDone: onClose });
  }

  const splat = draft.match === "PREFIX" && normal?.toUrl.endsWith("/*");
  const base = normal ? normal.fromPath.replace(/\/\*$/, "") || "/" : null;
  const sentence = normal
    ? draft.match === "PREFIX"
      ? `Visitors to ${base} and everything under it go to ${splat ? `${normal.toUrl.slice(0, -2) || "/"}/… — the rest of the address carried over` : normal.toUrl}.`
      : `Visitors to ${normal.fromPath} go to ${normal.toUrl}.`
    : null;

  return (
    <Dialog open onClose={close} title={row ? "Edit redirect" : "New redirect"} large>
      <form onSubmit={submit} noValidate className="space-y-5 p-0.5" aria-busy={action.pending || undefined}>
        {locked && (
          <p className="flex items-start gap-1.5 rounded-lg border border-warning/40 bg-warning-bg px-3 py-2 text-xs text-warning">
            <TriangleAlert aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0" />
            <span>This redirect sends visitors to another site, so only an admin can change where it goes. You can change its note, or switch it off.</span>
          </p>
        )}
        {row?.automatic && <p className="text-xs text-muted">Made automatically when the address of a page, post, category or tag changed. You can change it like any other.</p>}

        <TextField
          inputRef={fromRef}
          label="Old address"
          value={draft.from}
          onChange={(v) => update({ from: v })}
          max={REDIRECT_PATH_MAX}
          required
          mono
          readOnly={locked || action.pending}
          placeholder={draft.match === "PREFIX" ? "/old-section/*" : "/old-page"}
          error={shown.from}
          hint={normal && normal.fromPath !== draft.from.trim() ? `Stored as ${normal.fromPath} — lower-case, without a trailing slash or ?query.` : "A path on this site. Its ?query is ignored; capitals don't matter."}
        />

        <fieldset className="space-y-2" disabled={locked || action.pending}>
          <legend className="mb-1 text-[13px] font-medium text-muted">Which addresses</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {(
              [
                ["EXACT", "Only this address", "/old-page, and nothing under it."],
                ["PREFIX", "This address and everything under it", "/old/*: /old, /old/a, /old/a/b… End the target in /* to carry the rest over."],
              ] as const
            ).map(([value, title, detail]) => (
              <label key={value} className={cn("flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5", draft.match === value ? "border-brand bg-brand-subtle" : "border-line hover:bg-surface-sunken")}>
                <input type="radio" name={matchName} value={value} checked={draft.match === value} onChange={() => update({ match: value })} className="mt-0.5 h-4 w-4 shrink-0 accent-brand" />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-text">{title}</span>
                  <span className="mt-0.5 block text-xs text-muted">{detail}</span>
                </span>
              </label>
            ))}
          </div>
          {shown.match && <p className="text-xs text-danger">{shown.match}</p>}
        </fieldset>

        <TextField
          label="Goes to"
          value={draft.to}
          onChange={(v) => update({ to: v })}
          max={REDIRECT_PATH_MAX}
          required
          mono
          readOnly={locked || action.pending}
          placeholder={admin ? "/new-page or https://…" : "/new-page"}
          error={shown.to}
          hint={admin ? "A path on this site (/pricing), or another site's https:// address." : "A path on this site, like /pricing. Only an admin can send visitors to another site."}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={statusId}>Status</Label>
            <Select id={statusId} value={String(draft.status)} onChange={(e) => update({ status: Number(e.target.value) as RedirectStatus })} disabled={locked || action.pending} aria-describedby={`${statusId}-hint`}>
              {REDIRECT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s].short}
                </option>
              ))}
            </Select>
            <p id={`${statusId}-hint`} className={cn("text-xs", shown.status ? "text-danger" : "text-muted")}>
              {shown.status ?? STATUS_LABELS[draft.status].long}
            </p>
          </div>
          <div className="space-y-1.5">
            <p className="text-[13px] font-medium text-muted">On the site</p>
            <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-line px-3 py-2.5">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) => update({ enabled: e.target.checked })}
                disabled={action.pending || (locked && !row?.enabled)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-brand"
              />
              <span className="text-sm text-text">
                Switched on
                <span className="block text-xs text-muted">
                  {locked && !row?.enabled ? "An admin switches it back on." : "Off keeps it here without sending anybody anywhere."}
                </span>
              </span>
            </label>
          </div>
        </div>

        <TextAreaField
          id={noteId}
          label="Note"
          value={draft.note}
          onChange={(v) => update({ note: v })}
          max={REDIRECT_NOTE_MAX}
          rows={2}
          readOnly={action.pending}
          placeholder="Why it's here — the campaign, the old site, the ticket"
          error={shown.note}
        />

        <div aria-live="polite" className="space-y-2">
          {sentence && !blocked && (
            <p className="flex items-start gap-1.5 rounded-lg border border-line bg-surface-sunken px-3 py-2 text-xs text-text">
              <Info aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0 text-muted" />
              <span>
                {sentence} {STATUS_LABELS[draft.status].short}.{draft.enabled ? "" : " Switched off for now."}
              </span>
            </p>
          )}
          {chain && !chain.loop && serverCheck?.ok && (
            <div className="flex flex-wrap items-start gap-2 rounded-lg border border-warning/40 bg-warning-bg px-3 py-2 text-xs text-warning">
              <TriangleAlert aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0" />
              <span className="min-w-48 flex-1">
                {`Visitors pass through ${chain.hops} redirects: ${[...chain.through, chain.final].join(" → ")}. That's allowed, but slower — point it straight at ${chain.final}.`}
              </span>
              {!locked && (
                <Button type="button" variant="secondary" size="sm" onClick={() => update({ to: chain.final })} disabled={action.pending}>
                  Point it straight at {chain.final}
                </Button>
              )}
            </div>
          )}
          {covers && normal && !blocked && (
            <div className="flex items-start gap-1.5 rounded-lg border border-warning/40 bg-warning-bg px-3 py-2 text-xs text-warning">
              <EyeOff aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0" />
              <div className="min-w-0 space-y-1 break-words">
                <p>{coversSentence(covers, normal.toUrl)}</p>
                {covers.examples.some((a) => a.kind === "post" || a.kind === "page") && (
                  <p>To give a page or post a new address, change it in its editor instead — the redirect from the old one is made for you.</p>
                )}
              </div>
            </div>
          )}
          {general && (
            <p className="flex items-start gap-1.5 text-xs text-danger">
              <TriangleAlert aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0" />
              {general}
            </p>
          )}
          {checking ? (
            <p className="text-xs text-subtle">Checking for loops and chains…</p>
          ) : fresh?.failed ? (
            <p className="text-xs text-subtle">Loops and chains couldn&apos;t be checked just now; they are checked again when you save.</p>
          ) : serverCheck?.ok && !chain ? (
            <p className="inline-flex items-center gap-1 text-xs text-success">
              <CircleCheck aria-hidden="true" className="h-3.5 w-3.5" />
              No loop, no chain.
            </p>
          ) : null}
          {!row && used >= MAX_REDIRECTS * 0.9 && <p className="text-xs text-warning">{`${used.toLocaleString("en-IN")} of ${MAX_REDIRECTS.toLocaleString("en-IN")} redirects are used.`}</p>}
        </div>

        <ActionNoticeRegion notice={action.error ? { tone: "error", message: action.error } : null} />
        <div className="sticky bottom-0 flex flex-col-reverse gap-2 bg-surface pt-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="secondary" onClick={close} disabled={action.pending}>
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={unchanged || (tried && blocked)}
            aria-disabled={action.pending || undefined}
            aria-busy={action.pending || undefined}
            className={action.pending ? "cursor-wait opacity-70" : undefined}
          >
            {action.pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
            {row ? "Save redirect" : "Add redirect"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** "New redirect", for the page header: the dialog is mounted while open, so each opening starts clean. */
export function NewRedirectButton({ admin, siteHost, used }: { admin: boolean; siteHost: string; used: number }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" size="sm" onClick={() => setOpen(true)} aria-haspopup="dialog">
        <Plus aria-hidden="true" className="h-4 w-4" />
        New redirect
      </Button>
      {open && <RedirectDialog row={null} admin={admin} siteHost={siteHost} used={used} onClose={() => setOpen(false)} />}
    </>
  );
}
