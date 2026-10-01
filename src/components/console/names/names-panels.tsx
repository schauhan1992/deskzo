"use client";

import { useEffect, useId, useState, useTransition, type FormEvent } from "react";
import { CircleCheck, CircleX, LoaderCircle, Lock, Plus } from "lucide-react";
import { consoleBlockName, consoleNameImpact, consoleReleaseName, consoleRemoveNameRule, consoleTestName, type NameImpact, type NameTest } from "@/actions/platform/console-names";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { RowMenu } from "@/components/console/kit/row-menu";
import { LabelPill, StatusPill } from "@/components/console/kit/status";
import { DataTable, RowActionsCell, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { plural } from "@/lib/console-shared/format";
import { NAME_RULE_KIND } from "@/lib/console-shared/labels";
import type { BuiltInWord, NameRuleRow } from "@/lib/platform/names-console";
import { cn } from "@/lib/utils";
import { OUR_NAMES, blockProblem } from "@/lib/workspace-names";

/**
 * The console's "Workspace names" page, its interactive parts (src/app/platform-console/(console)/
 * names): testing a name, staff's rules with blocking and unblocking, and the built-in words with
 * releasing and blocking again. Every change asks first, and says what it does to the workspaces that
 * already have such a name — they keep it. Managers only; everybody else sees the same lists, still.
 */

const REASON = { label: "Why", minLength: 3, maxLength: 500, placeholder: "Staff read this later. Customers never see it." } as const;

/** The workspaces a rule touches, as a sentence: who keeps their address. */
function keepers(t: { workspaces: string[]; workspaceCount: number }, what: string): string {
  if (t.workspaceCount === 0) return `No workspace has ${what} now.`;
  const named = t.workspaces.join(", ");
  const more = t.workspaceCount - t.workspaces.length;
  return `${plural(t.workspaceCount, "workspace")} ${t.workspaceCount === 1 ? "has" : "have"} ${what} already and ${t.workspaceCount === 1 ? "keeps its address" : "keep their addresses"}: ${named}${more > 0 ? ` and ${more} more` : ""}.`;
}

// ─── Test a name ─────────────────────────────────────────────────────────────────────────────────

/** Type a name (and a registered business name, if you like) and see what signup would say, and which rule decided. */
export function NameTestBox() {
  const id = useId();
  const [slug, setSlug] = useState("");
  const [legalName, setLegalName] = useState("");
  const [result, setResult] = useState<NameTest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!slug.trim() || pending) return;
    setError(null);
    startTransition(async () => {
      try {
        const r = await consoleTestName({ slug, legalName });
        if (r.ok) setResult(r.data);
        else {
          setResult(null);
          setError(r.error);
        }
      } catch {
        setError("Something went wrong — try again.");
      }
    });
  }

  const nameId = `${id}-name`;
  const legalId = `${id}-legal`;
  return (
    <div className="space-y-4">
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
        <div className="space-y-1.5">
          <Label htmlFor={nameId}>Name</Label>
          <Input id={nameId} value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="acmetechnologies" autoComplete="off" autoCapitalize="off" spellCheck={false} className="font-mono" maxLength={64} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={legalId}>Registered business name (optional)</Label>
          <Input id={legalId} value={legalName} onChange={(e) => setLegalName(e.target.value)} placeholder="Acme Technologies Pvt Ltd" autoComplete="off" maxLength={120} />
        </div>
        <Button type="submit" disabled={pending || !slug.trim()} aria-busy={pending || undefined}>
          {pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
          Test
        </Button>
      </form>
      <ActionNoticeRegion notice={error ? { tone: "error", message: error } : null} />
      <div aria-live="polite">
        {result && (
          <dl className="grid gap-3 rounded-lg border border-line bg-surface-sunken px-4 py-3 text-sm sm:grid-cols-2">
            <Outcome title="Signup would say" ok={result.signup.ok} says={result.signup.says} decidedBy={result.signup.decidedBy} reason={result.signup.reason} />
            <Outcome title="A workspace staff set up" ok={result.staff.ok} says={result.staff.says} decidedBy={result.staff.decidedBy} reason={null} />
          </dl>
        )}
      </div>
    </div>
  );
}

function Outcome({ title, ok, says, decidedBy, reason }: { title: string; ok: boolean; says: string; decidedBy: string; reason: string | null }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{title}</dt>
      <dd className="mt-1 space-y-1">
        <p className={cn("flex items-start gap-1.5 font-medium", ok ? "text-success" : "text-danger")}>
          {ok ? <CircleCheck aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" /> : <CircleX aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />}
          <span className="min-w-0 break-words">“{says}”</span>
        </p>
        <p className="text-xs text-muted">Decided by: {decidedBy}</p>
        {reason && <p className="text-xs break-words text-muted">Staff&apos;s reason: {reason}</p>}
      </dd>
    </div>
  );
}

// ─── Block a name ────────────────────────────────────────────────────────────────────────────────

type BlockKind = "BLOCK_EXACT" | "BLOCK_WORD";

/** "Block a name": the button, and the dialog — the name or word, how it applies, why, and who already has it. */
export function BlockNameButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" size="sm" onClick={() => setOpen(true)}>
        <Plus aria-hidden="true" className="h-4 w-4" />
        Block a name
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Block a name">
        {open && <BlockNameForm onClose={() => setOpen(false)} />}
      </Dialog>
    </>
  );
}

function BlockNameForm({ onClose }: { onClose: () => void }) {
  const id = useId();
  const action = useConsoleAction<{ id: string; workspaces: number }>();
  const [value, setValue] = useState("");
  const [kind, setKind] = useState<BlockKind>("BLOCK_EXACT");
  const [reason, setReason] = useState("");
  const [impact, setImpact] = useState<{ key: string; data: NameImpact } | null>(null);

  const clean = value.trim().toLowerCase();
  const key = `${kind}|${clean}`;
  const shapeProblem = clean ? blockProblem(clean, kind) : null;
  // Who has such a name already — asked half a second after the last key, for a name the rules allow.
  useEffect(() => {
    if (!clean || shapeProblem) return;
    const timer = setTimeout(() => {
      consoleNameImpact({ value: clean, kind })
        .then((r) => {
          if (r.ok) setImpact({ key, data: r.data });
        })
        .catch(() => {});
    }, 500);
    return () => clearTimeout(timer);
  }, [clean, kind, key, shapeProblem]);
  const shown = impact && impact.key === key ? impact.data : null;
  const problem = shapeProblem ?? shown?.problem ?? null;
  const ready = !!clean && !problem && reason.trim().length >= REASON.minLength && !action.pending;

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!ready) return;
    action.run(() => consoleBlockName({ value: clean, kind, reason }), {
      success: (data) => `Blocked${data.workspaces > 0 ? ` — ${plural(data.workspaces, "workspace")} that already ${data.workspaces === 1 ? "has" : "have"} it ${data.workspaces === 1 ? "keeps" : "keep"} it` : ""}.`,
      onDone: onClose,
    });
  }

  const valueId = `${id}-value`;
  const valueHint = `${id}-value-hint`;
  const reasonId = `${id}-reason`;
  const what = kind === "BLOCK_EXACT" ? "this name" : "a name with this word in it";
  return (
    <form onSubmit={submit} className="space-y-4 p-0.5" noValidate>
      <fieldset className="space-y-2">
        <legend className="text-[13px] font-medium text-muted">Block</legend>
        {(
          [
            ["BLOCK_EXACT", "This exact name", "Only this address is refused."],
            ["BLOCK_WORD", "Any name with this word in it", "Every address containing the word, hyphens ignored — at least three letters."],
          ] as const
        ).map(([k, label, hint]) => (
          <label key={k} className="flex cursor-pointer items-start gap-2.5 text-sm text-text">
            <input type="radio" name={`${id}-kind`} value={k} checked={kind === k} onChange={() => setKind(k)} disabled={action.pending} className="mt-1 accent-[var(--brand)]" />
            <span>
              {label}
              <span className="block text-xs text-muted">{hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="space-y-1.5">
        <Label htmlFor={valueId}>{kind === "BLOCK_EXACT" ? "Name" : "Word"}</Label>
        <Input
          id={valueId}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          maxLength={40}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          className="font-mono"
          aria-invalid={problem ? true : undefined}
          aria-describedby={valueHint}
          readOnly={action.pending}
        />
        <p id={valueHint} className={cn("text-xs", problem ? "text-danger" : "text-muted")}>
          {problem ?? (shown ? keepers(shown, what) : "New workspaces can't have it. A workspace that already has it keeps it.")}
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={reasonId}>{REASON.label}</Label>
        <Textarea id={reasonId} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={REASON.maxLength} placeholder={REASON.placeholder} rows={3} readOnly={action.pending} />
      </div>
      <p className="text-xs text-muted">Customers only ever read “That name is reserved.” — never this reason.</p>
      <ActionNoticeRegion notice={action.error ? { tone: "error", message: action.error } : null} />
      <div className="sticky bottom-0 flex flex-col-reverse gap-2 bg-surface pt-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="secondary" onClick={onClose} disabled={action.pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={!ready} aria-busy={action.pending || undefined}>
          {action.pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
          {kind === "BLOCK_EXACT" ? "Block name" : "Block word"}
        </Button>
      </div>
    </form>
  );
}

// ─── Staff's rules ───────────────────────────────────────────────────────────────────────────────

/** Staff's rules: what each blocks or releases, why, who made it and when — and, for managers, taking one away. */
export function NameRulesTable({ rows, manage }: { rows: NameRuleRow[]; manage: boolean }) {
  const [removing, setRemoving] = useState<NameRuleRow | null>(null);
  return (
    <>
      <DataTable caption="Staff rules for workspace names" minWidth={manage ? 920 : 880}>
        <THead>
          <Th>Name or word</Th>
          <Th>Rule</Th>
          <Th>Reason</Th>
          <Th>Workspaces with it</Th>
          <Th>By</Th>
          <Th>When</Th>
          {manage && <Th srOnly>Actions</Th>}
        </THead>
        <TBody>
          {rows.map((row) => (
            <Tr key={row.id}>
              <Td nowrap>
                <span className="font-mono text-xs text-text">{row.value}</span>
              </Td>
              <Td nowrap>
                <LabelPill map={NAME_RULE_KIND} value={row.kind} />
              </Td>
              <Td>
                <span className="block max-w-[22rem] min-w-40 text-sm break-words text-text">{row.reason}</span>
              </Td>
              <Td muted>
                {row.workspaceCount === 0 ? (
                  "—"
                ) : (
                  <span title={row.workspaces.join(", ")}>
                    {row.workspaceCount} <span className="font-mono text-xs">{row.workspaces.slice(0, 2).join(", ")}</span>
                    {row.workspaceCount > 2 ? "…" : ""}
                  </span>
                )}
              </Td>
              <Td muted nowrap>
                {row.createdByName}
              </Td>
              <Td muted nowrap>
                <RelativeTime at={row.createdAt} absolute="date" />
              </Td>
              {manage && (
                <RowActionsCell>
                  <RowMenu
                    label={`Actions for ${row.value}`}
                    items={[{ key: "remove", label: row.kind === "RELEASE" ? "Block again…" : "Unblock…", danger: row.kind === "RELEASE", onSelect: () => setRemoving(row) }]}
                  />
                </RowActionsCell>
              )}
            </Tr>
          ))}
        </TBody>
      </DataTable>
      {manage && <RemoveRuleDialog row={removing} onClose={() => setRemoving(null)} />}
    </>
  );
}

/** Taking a rule away: an unblock lets the name be had again; taking a release away blocks the word again. */
function RemoveRuleDialog({ row, onClose }: { row: NameRuleRow | null; onClose: () => void }) {
  const action = useConsoleAction<null>();
  const release = row?.kind === "RELEASE";
  function close() {
    if (action.pending) return;
    action.reset();
    onClose();
  }
  return (
    <ConfirmDialog
      open={row !== null}
      onClose={close}
      title={release ? "Block the word again" : "Unblock"}
      confirmLabel={release ? "Block again" : "Unblock"}
      tone={release ? "danger" : "primary"}
      pending={action.pending}
      error={action.error}
      onConfirm={() => {
        if (row) action.run(() => consoleRemoveNameRule(row.id), { success: release ? `"${row.value}" is reserved again.` : `${row.value} is no longer blocked.`, onDone: onClose });
      }}
    >
      {row &&
        (release ? (
          <>
            <p>
              New workspaces can&apos;t have <span className="font-mono">{row.value}</span> again — unless an invitation holds it with the reserved-word box ticked.
            </p>
            <p className="text-muted">{keepers(row, "it")}</p>
          </>
        ) : (
          <>
            <p>
              New workspaces may have {row.kind === "BLOCK_WORD" ? "names with the word" : "the name"} <span className="font-mono">{row.value}</span> again — unless a built-in rule refuses it.
            </p>
            <p className="text-muted">Its reason goes with it; the audit log keeps it.</p>
          </>
        ))}
    </ConfirmDialog>
  );
}

// ─── The built-in list ───────────────────────────────────────────────────────────────────────────

/** The platform's own addresses: locked, so no buttons — only why. */
export function PlatformHosts({ hosts }: { hosts: string[] }) {
  return (
    <div className="space-y-2">
      <h3 className="flex items-center gap-1.5 text-[13px] font-medium text-text">
        <Lock aria-hidden="true" className="h-3.5 w-3.5 text-muted" />
        Platform addresses
        <StatusPill tone="neutral">Locked · {hosts.length}</StatusPill>
      </h3>
      <p className="text-xs text-muted">
        The platform answers on these itself, now or later — its hosts, mail, environments, sign-in and legal pages. They can never be a workspace&apos;s address:
        no release, no hold, no block needed.
      </p>
      <ul aria-label="Platform addresses, locked" className="flex flex-wrap gap-1.5">
        {hosts.map((h) => (
          <li key={h} className="rounded-md border border-line bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] text-muted">
            {h}
          </li>
        ))}
      </ul>
    </div>
  );
}

type Pending = { kind: "release" | "reblock"; word: BuiltInWord } | null;

/** One group of releasable built-in words — reserved, ours, competitors' — each released or not, with its button for managers. */
export function BuiltInWords({ title, description, words, manage }: { title: string; description: string; words: BuiltInWord[]; manage: boolean }) {
  const [pending, setPending] = useState<Pending>(null);
  const released = words.filter((w) => w.release).length;
  return (
    <div className="space-y-2">
      <h3 className="flex items-center gap-1.5 text-[13px] font-medium text-text">
        {title}
        <StatusPill tone="neutral">{words.length}</StatusPill>
        {released > 0 && <StatusPill tone="info">{released} released</StatusPill>}
      </h3>
      <p className="text-xs text-muted">{description}</p>
      <ul aria-label={title} className="flex flex-wrap gap-1.5">
        {words.map((w) => (
          <li
            key={w.word}
            className={cn(
              "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px]",
              w.release ? "border-info/30 bg-info-bg text-info" : "border-line bg-surface text-text",
            )}
            title={w.release ? `Released by ${w.release.createdByName}: ${w.release.reason}` : undefined}
          >
            <span className="font-mono">{w.word}</span>
            {w.release && <span className="sr-only">(released)</span>}
            {manage && (
              <button
                type="button"
                onClick={() => setPending({ kind: w.release ? "reblock" : "release", word: w })}
                className="rounded px-1 text-[11px] font-medium text-brand hover:bg-brand-subtle hover:underline"
                aria-label={w.release ? `Block ${w.word} again` : `Release ${w.word}`}
              >
                {w.release ? "Block again" : "Release"}
              </button>
            )}
          </li>
        ))}
      </ul>
      {manage && (
        <>
          <ReleaseDialog word={pending?.kind === "release" ? pending.word : null} onClose={() => setPending(null)} />
          <ReblockDialog word={pending?.kind === "reblock" ? pending.word : null} onClose={() => setPending(null)} />
        </>
      )}
    </div>
  );
}

/** What releasing a built-in word lets through, by its group. */
function releaseMeaning(w: BuiltInWord): string {
  if (w.group === "reserved") return `A new workspace may then be called ${w.word} — set up by staff, or held for a customer on an invitation. Signup's own rules still apply to a business signing itself up.`;
  if (w.group === "ours") return `New addresses with ${w.word} anywhere in them — ${w.word}tech, my-${w.word} — are then allowed. ${w.word === OUR_NAMES[0] ? "It is the platform's own name." : ""}`.trim();
  return `New addresses with ${w.word} as a word, or starting with it — ${w.word}-india, ${w.word}partners — are then allowed.`;
}

function ReleaseDialog({ word, onClose }: { word: BuiltInWord | null; onClose: () => void }) {
  const action = useConsoleAction<{ id: string }>();
  function close() {
    if (action.pending) return;
    action.reset();
    onClose();
  }
  return (
    <ConfirmDialog
      open={word !== null}
      onClose={close}
      title="Release a built-in word"
      confirmLabel="Release"
      pending={action.pending}
      error={action.error}
      reason={REASON}
      onConfirm={({ reason }) => {
        if (word) action.run(() => consoleReleaseName({ value: word.word, reason }), { success: `"${word.word}" is released.`, onDone: onClose });
      }}
    >
      {word && (
        <>
          <p>
            Release <span className="font-mono">{word.word}</span>? {releaseMeaning(word)}
          </p>
          <p className="text-muted">Block it again at any time; workspaces made meanwhile keep their addresses.</p>
        </>
      )}
    </ConfirmDialog>
  );
}

function ReblockDialog({ word, onClose }: { word: BuiltInWord | null; onClose: () => void }) {
  const action = useConsoleAction<null>();
  function close() {
    if (action.pending) return;
    action.reset();
    onClose();
  }
  return (
    <ConfirmDialog
      open={word !== null}
      onClose={close}
      title="Block the word again"
      confirmLabel="Block again"
      tone="danger"
      pending={action.pending}
      error={action.error}
      onConfirm={() => {
        if (word?.release) action.run(() => consoleRemoveNameRule(word.release!.id), { success: `"${word.word}" is reserved again.`, onDone: onClose });
      }}
    >
      {word && (
        <>
          <p>
            New workspaces can&apos;t have <span className="font-mono">{word.word}</span> again — unless an invitation holds it with the reserved-word box ticked.
          </p>
          <p className="text-muted">{keepers(word, word.group === "reserved" ? "it" : "a name with it")}</p>
        </>
      )}
    </ConfirmDialog>
  );
}
