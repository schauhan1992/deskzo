"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Ellipsis, FileBarChart2, Search, Star } from "lucide-react";
import { deleteReport, duplicateReport, listReports, requestReportAccess, setReportFavourite, type ReportRow } from "@/actions/reporting";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/menu";
import { cn } from "@/lib/utils";
import { Toast, When, useToast } from "./controls";

export type LibraryTab = "mine" | "shared" | "favourites";
type Data = { rows: ReportRow[]; total: number; counts: { mine: number; shared: number; favourites: number } };

const PAGE = 10;

/**
 * The reports somebody can open (the approved design's 1e and 1f): their own, those shared with them, and their
 * favourites — searched, filtered, sorted and paged on the server, which only ever lists what they may open.
 */
export function ReportLibrary({ tab: initialTab, sources }: { tab: LibraryTab; sources: { key: string; label: string }[] }) {
  const router = useRouter();
  const [tab, setTab] = useState<LibraryTab>(initialTab);
  const [search, setSearch] = useState("");
  const [source, setSource] = useState("");
  const [status, setStatus] = useState<"" | "shared" | "private">("");
  const [sort, setSort] = useState<"edited" | "name" | "created">("edited");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState<ReportRow | null>(null);
  const [requested, setRequested] = useState<Set<string>>(new Set());
  const { toast, show, clear } = useToast();

  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      setLoading(true);
      listReports({ tab, search, source, status: tab === "mine" ? status : "", sort, page, pageSize: PAGE })
        .then((res) => {
          if (!live) return;
          if (res.ok) {
            setData(res.data);
            setError(null);
          } else setError(res.error);
        })
        .catch(() => live && setError("Couldn't load your reports. Check your connection."))
        .finally(() => live && setLoading(false));
    }, search ? 250 : 0);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [tab, search, source, status, sort, page, reload]);

  function switchTab(next: LibraryTab) {
    setTab(next);
    setPage(1);
    // The address follows the tab, so a reload or a shared link lands on the same list.
    window.history.replaceState(null, "", next === "shared" ? "/reports/shared" : next === "favourites" ? "/reports/library?tab=favourites" : "/reports/library");
  }

  async function act(fn: () => Promise<{ ok: boolean; error?: string }>, done: string) {
    try {
      const res = await fn();
      if (!res.ok) return show(res.error ?? "That didn't work.", { failed: true });
      show(done);
      setReload((n) => n + 1);
    } catch {
      show("That didn't work. Check your connection and try again.", { failed: true });
    }
  }

  async function duplicate(row: ReportRow) {
    try {
      const res = await duplicateReport(row.id);
      if (!res.ok) return show(res.error, { failed: true });
      router.push(`/reports/${res.data.id}/edit`);
    } catch {
      show("Couldn't duplicate the report.", { failed: true });
    }
  }

  const counts = data?.counts;
  const total = data?.total ?? 0;
  const from = total === 0 ? 0 : (page - 1) * PAGE + 1;
  const to = Math.min(total, page * PAGE);
  const tabs: { key: LibraryTab; label: string; n?: number }[] = [
    { key: "mine", label: "My reports", n: counts?.mine },
    { key: "shared", label: "Shared with me", n: counts?.shared },
    { key: "favourites", label: "Favourites", n: counts?.favourites },
  ];

  const rowMenu = (r: ReportRow) => (
    <Menu label={`Actions for ${r.name}`} icon={Ellipsis} width={210}>
      {(close) => (
        <>
          <MenuItem onClick={() => (close(), router.push(`/reports/${r.id}`))}>Open</MenuItem>
          {r.canEdit && <MenuItem onClick={() => (close(), router.push(`/reports/${r.id}/edit`))}>Edit in builder</MenuItem>}
          <MenuItem onClick={() => (close(), void duplicate(r))}>Duplicate</MenuItem>
          {r.access === "owner" && <MenuItem onClick={() => (close(), router.push(`/reports/${r.id}?share=1`))}>Share…</MenuItem>}
          <MenuItem onClick={() => (close(), router.push(`/reports/${r.id}`))}>Export…</MenuItem>
          <MenuItem onClick={() => (close(), void act(() => setReportFavourite(r.id, !r.favourite), r.favourite ? "Removed from favourites" : "Added to favourites"))}>
            {r.favourite ? "Remove from favourites" : "Add to favourites"}
          </MenuItem>
          {r.access === "owner" && (
            <>
              <MenuSeparator />
              <MenuItem danger onClick={() => (close(), setConfirmDelete(r))}>
                Delete
              </MenuItem>
            </>
          )}
        </>
      )}
    </Menu>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-semibold text-text">Reports</h1>
          <p className="text-[13.5px] text-muted">Everything you&apos;ve built, and what others have shared with you.</p>
        </div>
        <Link href="/reports/new" className="inline-flex h-9 items-center rounded-base bg-brand px-3.5 text-sm font-medium text-brand-contrast shadow-sm hover:brightness-110">
          Create report
        </Link>
      </div>

      <div className="flex gap-1 overflow-x-auto border-b border-line" role="tablist">
        {tabs.map((t) => (
          <button key={t.key} role="tab" type="button" aria-selected={tab === t.key} onClick={() => switchTab(t.key)} className={cn("h-10 shrink-0 border-b-2 px-3 text-[13.5px] font-medium", tab === t.key ? "border-brand text-text" : "border-transparent text-muted hover:text-text")}>
            {t.label}
            {t.n !== undefined && <span className="ml-1.5 text-[12px] font-normal text-subtle">{t.n}</span>}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-subtle" />
          <input
            value={search}
            onChange={(e) => (setSearch(e.target.value), setPage(1))}
            placeholder={tab === "shared" ? "Search shared reports…" : "Search my reports…"}
            className="h-9 w-full rounded-lg border border-line bg-surface pl-8 pr-2.5 text-[13px] text-text outline-none focus:border-brand"
          />
        </label>
        <select aria-label="Source" value={source} onChange={(e) => (setSource(e.target.value), setPage(1))} className="h-9 rounded-lg border border-line bg-surface px-2.5 text-[13px] text-text">
          <option value="">Source: All</option>
          {sources.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </select>
        {tab === "mine" && (
          <select aria-label="Status" value={status} onChange={(e) => (setStatus(e.target.value as typeof status), setPage(1))} className="h-9 rounded-lg border border-line bg-surface px-2.5 text-[13px] text-text">
            <option value="">Status: All</option>
            <option value="shared">Shared</option>
            <option value="private">Only me</option>
          </select>
        )}
        <select aria-label="Sort" value={sort} onChange={(e) => (setSort(e.target.value as typeof sort), setPage(1))} className="h-9 rounded-lg border border-line bg-surface px-2.5 text-[13px] text-text sm:ml-auto">
          <option value="edited">Sort: Last edited</option>
          <option value="name">Sort: Name</option>
          <option value="created">Sort: Newest</option>
        </select>
      </div>

      {error ? (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-danger/30 bg-danger-bg px-4 py-3 text-[13px] text-danger">
          {error}
          <Button type="button" size="sm" variant="secondary" onClick={() => setReload((n) => n + 1)}>
            Retry
          </Button>
        </div>
      ) : !data ? (
        <div className="space-y-2 rounded-xl border border-line bg-surface p-4" aria-label="Loading">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="h-10 animate-pulse rounded-md bg-surface-sunken" />
          ))}
        </div>
      ) : data.rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line-strong px-6 py-14 text-center">
          <FileBarChart2 className="mx-auto h-6 w-6 text-subtle" />
          <p className="mt-2 text-[15px] font-semibold text-text">
            {search || source || status ? "No reports match" : tab === "shared" ? "Nothing shared with you yet" : tab === "favourites" ? "No favourites yet" : "You haven't made a report yet"}
          </p>
          <p className="mt-1 text-[13px] text-muted">
            {search || source || status
              ? "Try another search or clear the filters."
              : tab === "shared"
                ? "When a colleague shares a report with you or your department, it shows here."
                : tab === "favourites"
                  ? "Star a report to keep it close."
                  : "Start blank or from a template."}
          </p>
          {tab === "mine" && !search && !source && !status && (
            <Link href="/reports/new" className="mt-4 inline-flex h-9 items-center rounded-base bg-brand px-3.5 text-sm font-medium text-brand-contrast shadow-sm hover:brightness-110">
              Create report
            </Link>
          )}
        </div>
      ) : tab === "shared" ? (
        <div className={cn("overflow-hidden rounded-xl border border-line bg-surface shadow-sm", loading && "opacity-60")}>
          {data.rows.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3 last:border-0">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-surface-sunken text-[11px] font-semibold text-muted">{r.owner.initials}</span>
              <div className="min-w-0 flex-1">
                <Link href={`/reports/${r.id}`} className="block truncate text-[14px] font-medium text-text hover:underline">
                  {r.name}
                </Link>
                <p className="text-[12.5px] text-subtle">
                  Shared by {r.owner.name} · <When iso={r.updatedAt} />
                </p>
                {!r.sourceOpen && <p className="text-[12.5px] text-warning">Reads {r.sourceLabel}, which your role can&apos;t open</p>}
              </div>
              {r.sourceOpen ? (
                <span className={cn("rounded-full px-2 py-0.5 text-[12px] font-medium", r.canEdit ? "bg-brand-subtle text-brand" : "bg-surface-sunken text-muted")}>{r.canEdit ? "Can edit" : "Can view"}</span>
              ) : (
                <span className="rounded-full bg-danger-bg px-2 py-0.5 text-[12px] font-medium text-danger">No access</span>
              )}
              {r.sourceOpen ? (
                <Link href={`/reports/${r.id}`} className="inline-flex h-9 items-center rounded-base border border-line-strong px-3.5 text-[13px] font-medium text-text hover:bg-surface-sunken">
                  Open
                </Link>
              ) : (
                <Button
                  type="button"
                  variant="secondary"
                  size="md"
                  disabled={requested.has(r.id)}
                  onClick={async () => {
                    try {
                      const res = await requestReportAccess(r.id);
                      if (!res.ok) return show(res.error, { failed: true });
                      setRequested(new Set([...requested, r.id]));
                      show(`${r.owner.name} has been asked`);
                    } catch {
                      show("Couldn't send the request.", { failed: true });
                    }
                  }}
                >
                  {requested.has(r.id) ? "Requested" : "Request access"}
                </Button>
              )}
              {rowMenu(r)}
            </div>
          ))}
          <p className="border-t border-line px-4 py-3 text-[12.5px] text-subtle">
            A shared report never widens access: each person sees the rows their own role allows, so the same report can show different totals.
          </p>
        </div>
      ) : (
        <div className={cn("overflow-x-auto rounded-xl border border-line bg-surface shadow-sm", loading && "opacity-60")}>
          <table className="w-full min-w-[760px] text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-[11.5px] uppercase tracking-[0.05em] text-subtle">
                <th className="px-4 py-2.5 font-medium">Name</th>
                <th className="px-3 py-2.5 font-medium">Source</th>
                <th className="px-3 py-2.5 font-medium">Pages</th>
                <th className="px-3 py-2.5 font-medium">Shared with</th>
                <th className="px-3 py-2.5 font-medium">Last edited</th>
                <th className="px-3 py-2.5 font-medium">Status</th>
                <th className="w-10 px-2 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id} className="border-b border-line last:border-0 hover:bg-surface-sunken/60">
                  <td className="px-4 py-2.5">
                    <Link href={`/reports/${r.id}`} className="flex items-center gap-2">
                      {r.favourite && <Star className="h-3.5 w-3.5 shrink-0 fill-warning text-warning" />}
                      <span className="min-w-0">
                        <span className="block font-medium text-text hover:underline">{r.name}</span>
                        {r.description && <span className="block max-w-[360px] truncate text-[12px] text-subtle">{r.description}</span>}
                      </span>
                    </Link>
                  </td>
                  <td className="px-3 py-2.5 text-muted">{r.sourceLabel}</td>
                  <td className="px-3 py-2.5 tabular-nums text-muted">{r.pages}</td>
                  <td className="px-3 py-2.5 text-muted">{r.sharedWith}</td>
                  <td className="px-3 py-2.5 text-muted">
                    <When iso={r.updatedAt} />
                  </td>
                  <td className="px-3 py-2.5">
                    {!r.sourceOpen ? (
                      <span className="rounded-full bg-danger-bg px-2 py-0.5 text-[12px] font-medium text-danger">No access</span>
                    ) : r.access !== "owner" ? (
                      <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-[12px] font-medium text-muted">{r.canEdit ? "Can edit" : "Can view"}</span>
                    ) : r.shared ? (
                      <span className="rounded-full bg-brand-subtle px-2 py-0.5 text-[12px] font-medium text-brand">Shared</span>
                    ) : (
                      <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-[12px] font-medium text-muted">Private</span>
                    )}
                  </td>
                  <td className="px-2 py-2.5">{rowMenu(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && total > 0 && (
        <div className="flex items-center justify-between text-[13px] text-muted">
          <span>
            {from}–{to} of {total} report{total === 1 ? "" : "s"}
          </span>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" size="sm" disabled={page <= 1 || loading} onClick={() => setPage(page - 1)}>
              Previous
            </Button>
            <Button type="button" variant="secondary" size="sm" disabled={to >= total || loading} onClick={() => setPage(page + 1)}>
              Next
            </Button>
          </div>
        </div>
      )}

      {confirmDelete && (
        <Dialog open onClose={() => setConfirmDelete(null)} title={`Delete “${confirmDelete.name}”?`}>
          <p className="text-[13.5px] text-muted">
            The report goes for everyone it is shared with{confirmDelete.shared ? ` (${confirmDelete.sharedWith.toLowerCase()})` : ""}. The data it reads is not touched. This can&apos;t be undone.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmDelete(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="danger"
              size="sm"
              onClick={() => {
                const r = confirmDelete;
                setConfirmDelete(null);
                void act(() => deleteReport(r.id), `Deleted “${r.name}”`);
              }}
            >
              Delete report
            </Button>
          </div>
        </Dialog>
      )}
      <Toast toast={toast} onClose={clear} />
    </div>
  );
}
