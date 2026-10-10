"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, Pencil } from "lucide-react";
import { changeCardHandle, issueDigitalCards, switchOffCards } from "@/actions/card";
import type { ManagedPerson } from "@/lib/cards/views";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";

type Choice = { id: string; name: string };
type TemplateChoice = Choice & { isDefault: boolean };
type Show = "all" | "live" | "none" | "off";

/**
 * Who has a card: issue them one at a time, by ticking, or to a whole department, branch or role at
 * once; switch them off; move them to another template; change a card's address.
 */
export function CardsPeopleTable({
  people,
  liveCount,
  templates,
  departments,
  branches,
  roles,
}: {
  people: ManagedPerson[];
  liveCount: number;
  templates: TemplateChoice[];
  departments: Choice[];
  branches: Choice[];
  roles: { key: string; name: string }[];
}) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [show, setShow] = useState<Show>("all");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [templateId, setTemplateId] = useState("");
  const [groupKind, setGroupKind] = useState<"departmentId" | "branchId" | "role" | "everyone">("departmentId");
  const [groupValue, setGroupValue] = useState("");
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [pending, start] = useTransition();

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return people.filter((p) => {
      if (needle && !`${p.name} ${p.email} ${p.department ?? ""} ${p.branch ?? ""}`.toLowerCase().includes(needle)) return false;
      if (show === "live") return !!p.card?.live;
      if (show === "none") return !p.card;
      if (show === "off") return !!p.card && !p.card.live;
      return true;
    });
  }, [people, q, show]);

  const pickedPeople = people.filter((p) => picked.has(p.userId));
  const pickedCards = pickedPeople.flatMap((p) => (p.card?.status === "ACTIVE" ? [p.card.id] : []));

  function run(work: () => Promise<{ ok: true; text: string } | { ok: false; error: string }>) {
    setMessage(null);
    start(async () => {
      const result = await work();
      setMessage(result.ok ? { tone: "ok", text: result.text } : { tone: "error", text: result.error });
      if (result.ok) {
        setPicked(new Set());
        router.refresh();
      }
    });
  }

  const issue = (input: Record<string, unknown>) =>
    run(async () => {
      const result = await issueDigitalCards({ ...input, templateId: templateId || null });
      if (!result.ok) return result;
      const { issued, switchedOn, moved, skipped } = result.data;
      const parts = [
        issued ? `${issued} issued` : null,
        switchedOn ? `${switchedOn} switched back on` : null,
        moved ? `${moved} moved to the template` : null,
        skipped ? `${skipped} already had one` : null,
      ].filter(Boolean);
      return { ok: true, text: parts.length ? `${parts.join(", ")}.` : "Nothing to change." };
    });

  const groupOptions = groupKind === "departmentId" ? departments : groupKind === "branchId" ? branches : groupKind === "role" ? roles.map((r) => ({ id: r.key, name: r.name })) : [];

  return (
    <div className="space-y-4">
      <Card className="space-y-3 px-4 py-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="cards-template">Template</Label>
            <Select id="cards-template" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              <option value="">{templates.length ? "The default, or theirs" : "The default (made now)"}</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.isDefault ? " (default)" : ""}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cards-group">Issue to</Label>
            <div className="flex flex-wrap gap-2">
              <Select
                id="cards-group"
                value={groupKind}
                onChange={(e) => {
                  setGroupKind(e.target.value as typeof groupKind);
                  setGroupValue("");
                }}
              >
                <option value="departmentId">A department</option>
                <option value="branchId">A branch</option>
                <option value="role">A role</option>
                <option value="everyone">Everybody active</option>
              </Select>
              {groupKind !== "everyone" && (
                <Select aria-label="Which" value={groupValue} onChange={(e) => setGroupValue(e.target.value)}>
                  <option value="">Choose…</option>
                  {groupOptions.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </Select>
              )}
              <Button
                type="button"
                disabled={pending || (groupKind !== "everyone" && !groupValue)}
                onClick={() => issue(groupKind === "everyone" ? { everyone: true } : { [groupKind]: groupValue })}
              >
                Issue cards
              </Button>
            </div>
          </div>
        </div>
        <p className="text-xs text-subtle">
          {liveCount} {liveCount === 1 ? "card is" : "cards are"} live. Somebody who already has a card keeps it; choosing a template moves theirs onto it.
        </p>
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        <Input className="max-w-xs" placeholder="Search people" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search people" />
        <Select aria-label="Show" value={show} onChange={(e) => setShow(e.target.value as Show)} className="w-auto">
          <option value="all">Everybody</option>
          <option value="live">With a live card</option>
          <option value="none">Without a card</option>
          <option value="off">Switched off or left</option>
        </Select>
        {picked.size > 0 && (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted">{picked.size} chosen</span>
            <Button type="button" size="sm" disabled={pending} onClick={() => issue({ userIds: [...picked] })}>
              Issue or move
            </Button>
            <Button
              type="button"
              size="sm"
              variant="danger"
              disabled={pending || pickedCards.length === 0}
              onClick={() =>
                run(async () => {
                  const result = await switchOffCards(pickedCards);
                  return result.ok ? { ok: true, text: `${result.data.count} switched off.` } : result;
                })
              }
            >
              Switch off
            </Button>
          </div>
        )}
      </div>

      {message && <p className={message.tone === "ok" ? "text-sm text-success" : "text-sm text-danger"}>{message.text}</p>}

      <div className="overflow-x-auto rounded-xl border border-line bg-surface">
        <table className="w-full min-w-[44rem] text-sm">
          <thead className="border-b border-line text-left text-xs text-muted">
            <tr>
              <th className="w-10 px-3 py-2">
                <input
                  type="checkbox"
                  aria-label="Choose everybody shown"
                  checked={shown.length > 0 && shown.every((p) => picked.has(p.userId))}
                  onChange={(e) => setPicked(e.target.checked ? new Set(shown.map((p) => p.userId)) : new Set())}
                />
              </th>
              <th className="px-3 py-2 font-medium">Person</th>
              <th className="px-3 py-2 font-medium">Card</th>
              <th className="px-3 py-2 font-medium">Template</th>
              <th className="px-3 py-2 text-right font-medium" title="The last 30 days">
                Views · saved · shared
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {shown.map((p) => (
              <PersonRow
                key={p.userId}
                person={p}
                picked={picked.has(p.userId)}
                onPick={(on) => {
                  const next = new Set(picked);
                  if (on) next.add(p.userId);
                  else next.delete(p.userId);
                  setPicked(next);
                }}
              />
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-muted">
                  Nobody matches.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PersonRow({ person, picked, onPick }: { person: ManagedPerson; picked: boolean; onPick: (on: boolean) => void }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [handle, setHandle] = useState(person.card?.handle ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const card = person.card;

  return (
    <tr className={picked ? "bg-brand-subtle/40" : undefined}>
      <td className="px-3 py-2 align-top">
        <input type="checkbox" aria-label={`Choose ${person.name}`} checked={picked} onChange={(e) => onPick(e.target.checked)} />
      </td>
      <td className="px-3 py-2 align-top">
        <p className="font-medium text-text">{person.name}</p>
        <p className="text-xs text-muted">{[person.department, person.branch].filter(Boolean).join(" · ") || person.email}</p>
      </td>
      <td className="px-3 py-2 align-top">
        {!card ? (
          <Badge>No card</Badge>
        ) : (
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              {card.live ? <Badge tone="green">Live</Badge> : card.status === "OFF" ? <Badge>Off</Badge> : <Badge tone="amber">Left</Badge>}
              <a href={`/c/${card.handle}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-brand hover:underline">
                /c/{card.handle}
                <ExternalLink className="h-3 w-3" aria-hidden />
              </a>
              {!editing && (
                <button type="button" className="text-subtle hover:text-text" aria-label="Change the card's address" onClick={() => setEditing(true)}>
                  <Pencil className="h-3 w-3" />
                </button>
              )}
            </div>
            {editing && (
              <div className="space-y-1">
                <div className="flex gap-1">
                  <Input className="h-8 max-w-[12rem] text-xs" value={handle} onChange={(e) => setHandle(e.target.value)} aria-label="Card address" />
                  <Button
                    type="button"
                    size="sm"
                    disabled={pending}
                    onClick={() =>
                      start(async () => {
                        setError(null);
                        const result = await changeCardHandle(card.id, handle);
                        if (!result.ok) {
                          setError(result.error);
                          return;
                        }
                        setEditing(false);
                        router.refresh();
                      })
                    }
                  >
                    Save
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
                    Cancel
                  </Button>
                </div>
                <p className="text-[11px] text-warning">The old address stops working — printed QR codes and NFC tags with it too.</p>
                {error && <p className="text-xs text-danger">{error}</p>}
              </div>
            )}
          </div>
        )}
      </td>
      <td className="px-3 py-2 align-top text-muted">{card?.templateName ?? "—"}</td>
      <td className="px-3 py-2 text-right align-top tabular-nums text-muted">
        {card ? `${card.month.views} · ${card.month.saves} · ${card.month.shared}` : "—"}
      </td>
    </tr>
  );
}
