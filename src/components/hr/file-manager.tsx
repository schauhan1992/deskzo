"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ExternalLink, FileText, Folder, FolderOpen, Receipt, ScrollText, Search, ShieldCheck } from "lucide-react";
import type { FileItem, fileManagerPeople } from "@/actions/file-manager";
import { setEveryoneFileManagerAccess, setFileManagerAccess, setFileVisible, setFolderVisible } from "@/actions/file-manager";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { formatCalendarDay } from "@/lib/time/zone";
import { FILE_FOLDERS, type FolderKey } from "@/lib/hr/file-folders";

type Person = NonNullable<Awaited<ReturnType<typeof fileManagerPeople>>>[number];

const FOLDER_ICON: Record<FolderKey, typeof Folder> = {
  payslips: Receipt,
  "salary-certificates": ScrollText,
  joining: FileText,
  letters: ScrollText,
  documents: Folder,
};

/** An on/off switch, as Settings › Modules has. */
export function Switch({ on, label, disabled, onChange }: { on: boolean; label: string; disabled?: boolean; onChange: (next: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={cn("relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50", on ? "bg-brand" : "bg-line-strong")}
    >
      <span className={cn("absolute left-0 top-0.5 h-5 w-5 rounded-full bg-surface shadow transition-transform", on ? "translate-x-5" : "translate-x-0.5")} />
    </button>
  );
}

/**
 * The folders and the files in them. With `manage`, every file has its switch — on, the person it belongs
 * to sees it; off, it's kept from them everywhere — and each folder can be switched as a whole.
 */
export function FileBrowser({ files, manage }: { files: FileItem[]; manage?: { userId: string; name: string } }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [folder, setFolder] = useState<FolderKey | null>(null);
  // Switched at once on screen; put back if the server says no.
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const visibleOf = (f: FileItem) => overrides[`${f.kind}:${f.id}`] ?? f.visible;

  const byFolder = useMemo(() => {
    const map = new Map<FolderKey, FileItem[]>();
    for (const f of FILE_FOLDERS) map.set(f.key, []);
    for (const file of files) map.get(file.folder)?.push(file);
    return map;
  }, [files]);

  function toggle(file: FileItem, next: boolean) {
    const key = `${file.kind}:${file.id}`;
    setOverrides((o) => ({ ...o, [key]: next }));
    setError(null);
    startTransition(async () => {
      const result = await setFileVisible(file.kind, file.id, next);
      if (!result.ok) {
        setOverrides((o) => ({ ...o, [key]: !next }));
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  function toggleFolder(key: FolderKey, next: boolean) {
    if (!manage) return;
    setError(null);
    startTransition(async () => {
      const result = await setFolderVisible(manage.userId, key, next);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOverrides({});
      router.refresh();
    });
  }

  const open = folder ? FILE_FOLDERS.find((f) => f.key === folder)! : null;
  const list = folder ? (byFolder.get(folder) ?? []) : [];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        {FILE_FOLDERS.map((f) => {
          const items = byFolder.get(f.key) ?? [];
          const hidden = items.filter((i) => !visibleOf(i)).length;
          const Icon = folder === f.key ? FolderOpen : FOLDER_ICON[f.key];
          return (
            <button
              key={f.key}
              type="button"
              onClick={() => setFolder(folder === f.key ? null : f.key)}
              aria-pressed={folder === f.key}
              className={cn(
                "flex flex-col items-start gap-2 rounded-base border px-3 py-3 text-left transition-colors",
                folder === f.key ? "border-brand bg-brand-subtle/40" : "border-line bg-surface hover:bg-surface-sunken",
              )}
            >
              <Icon className={cn("h-6 w-6", folder === f.key ? "text-brand" : "text-muted")} aria-hidden />
              <span className="text-sm font-medium text-text">{f.label}</span>
              <span className="text-xs text-subtle">
                {items.length === 0 ? "Empty" : `${items.length} file${items.length === 1 ? "" : "s"}`}
                {manage && hidden > 0 && ` · ${hidden} off`}
              </span>
            </button>
          );
        })}
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}

      {!open && <p className="text-sm text-subtle">Open a folder to see what&apos;s in it.</p>}

      {open && (
        <Card className="overflow-hidden p-0">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
            <div>
              <h2 className="text-sm font-medium text-text">{open.label}</h2>
              <p className="text-xs text-subtle">{open.hint}</p>
            </div>
            {manage && list.length > 0 && (
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" disabled={pending} onClick={() => toggleFolder(open.key, true)}>
                  Show all to {manage.name.split(" ")[0]}
                </Button>
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => toggleFolder(open.key, false)}>
                  Hide all
                </Button>
              </div>
            )}
          </div>
          {list.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-subtle">Nothing in this folder.</p>
          ) : (
            <ul>
              {list.map((file) => {
                const on = visibleOf(file);
                return (
                  <li key={`${file.kind}:${file.id}`} className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2.5 last:border-0">
                    <FileText className={cn("h-5 w-5 shrink-0", on ? "text-brand" : "text-subtle")} aria-hidden />
                    <div className="min-w-0 flex-1">
                      <a href={file.href} target="_blank" rel="noreferrer" className="block truncate text-sm text-text hover:underline">
                        {file.name}
                      </a>
                      <span className="block truncate text-xs text-subtle">
                        {file.detail} · {formatCalendarDay(file.date)}
                      </span>
                    </div>
                    {file.withdrawn && <Badge tone="red">Withdrawn</Badge>}
                    <a
                      href={file.href}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`Open ${file.name}`}
                      className="grid h-8 w-8 place-items-center rounded-md text-muted hover:bg-surface-sunken hover:text-text"
                    >
                      <ExternalLink className="h-4 w-4" aria-hidden />
                    </a>
                    {manage && (
                      <span className="flex items-center gap-2">
                        <span className={cn("w-16 text-right text-xs", on ? "text-success" : "text-subtle")}>{on ? "Shown" : "Hidden"}</span>
                        <Switch on={on} label={`${on ? "Hide" : "Show"} ${file.name} ${on ? "from" : "to"} ${manage.name}`} disabled={pending} onChange={(next) => toggle(file, next)} />
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}

/**
 * Everybody, with the file manager on or off for each — the admin's to give. Choosing a name opens their
 * files beside the list.
 */
export function FileAccessList({ people, selectedId, search }: { people: Person[]; selectedId: string | null; search: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [term, setTerm] = useState(search);
  const has = (p: Person) => overrides[p.id] ?? p.hasAccess;
  const count = people.filter(has).length;

  function toggle(person: Person, next: boolean) {
    setOverrides((o) => ({ ...o, [person.id]: next }));
    setError(null);
    startTransition(async () => {
      const result = await setFileManagerAccess(person.id, next);
      if (!result.ok) {
        setOverrides((o) => ({ ...o, [person.id]: !next }));
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  function everyone(on: boolean) {
    const question = on
      ? "Give the file manager to everybody? Each person sees only their own files, and only the ones switched on."
      : "Take the file manager away from everybody but the admins?";
    if (!window.confirm(question)) return;
    setError(null);
    startTransition(async () => {
      const result = await setEveryoneFileManagerAccess(on);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOverrides({});
      router.refresh();
    });
  }

  const link = (id: string) => `/people/files?view=employees&person=${id}${search ? `&q=${encodeURIComponent(search)}` : ""}`;

  return (
    <Card className="overflow-hidden p-0">
      <div className="space-y-2 border-b border-line px-3 py-3">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            router.push(`/people/files?view=employees${term.trim() ? `&q=${encodeURIComponent(term.trim())}` : ""}`);
          }}
          className="relative"
        >
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" aria-hidden />
          <Input aria-label="Search people" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search name, email or code" className="h-9 pl-8" />
        </form>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
          <span>
            <ShieldCheck className="mr-1 inline h-3.5 w-3.5 text-brand" aria-hidden />
            {count} of {people.length} can open it
          </span>
          <span className="flex gap-1">
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => everyone(true)}>
              Give everyone
            </Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => everyone(false)}>
              Take from all
            </Button>
          </span>
        </div>
        {error && <p className="text-xs text-danger">{error}</p>}
      </div>
      <ul className="max-h-[36rem] overflow-y-auto">
        {people.length === 0 && <li className="px-3 py-8 text-center text-sm text-subtle">Nobody matches.</li>}
        {people.map((p) => (
          <li
            key={p.id}
            className={cn("flex items-center gap-2 border-b border-line px-3 py-2 last:border-0", selectedId === p.id && "bg-brand-subtle/40")}
          >
            <Link href={link(p.id)} className="min-w-0 flex-1">
              <span className="block truncate text-sm text-text">{p.name}</span>
              <span className="block truncate text-xs text-subtle">
                {p.code}
                {p.designation && ` · ${p.designation}`}
              </span>
            </Link>
            {p.fixed ? (
              <Badge tone="brand">Super admin</Badge>
            ) : (
              <Switch on={has(p)} label={`File manager for ${p.name}`} disabled={pending} onChange={(next) => toggle(p, next)} />
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
