"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Lock, Unlock } from "lucide-react";
import type { CardsOverview, CardTemplateRow } from "@/actions/cards";
import { deleteCardTemplate, issueCards, saveCardTemplate, setCardActive } from "@/actions/cards";
import { CARD_FIELDS, MAX_QUESTIONS, defaultTemplateFields, type TemplateField } from "@/lib/cards/template";
import { Card, CardContent, Badge } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";
import { ContactsTable } from "@/components/cards/my-card";

type Tab = "people" | "templates" | "contacts";

export function CardsManager({ data }: { data: CardsOverview }) {
  const [tab, setTab] = useState<Tab>(data.mayManage ? "people" : "contacts");
  const tabs: { key: Tab; label: string }[] = [
    { key: "people", label: "People" },
    ...(data.mayManage ? [{ key: "templates" as const, label: "Templates" }] : []),
    ...(data.mayViewLeads ? [{ key: "contacts" as const, label: `Shared back (${data.contacts.length})` }] : []),
  ];
  const live = data.rows.filter((r) => r.card?.active).length;

  return (
    <div className="animate-fade-rise space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-xl font-semibold text-text">Digital cards</h1>
        <span className="text-sm text-muted">
          {live} live of {data.rows.filter((r) => r.accountActive).length} people
        </span>
      </div>
      <div role="tablist" className="flex gap-1 border-b border-line">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === t.key ? "border-brand font-medium text-text" : "border-transparent text-muted hover:text-text"}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "people" && <PeopleTab data={data} />}
      {tab === "templates" && data.mayManage && <TemplatesTab templates={data.templates} />}
      {tab === "contacts" && data.mayViewLeads && (
        <Card>
          <CardContent className="py-4">
            {data.contacts.length === 0 ? (
              <p className="text-sm text-muted">Nobody has shared their details back from a card yet.</p>
            ) : (
              <ContactsTable contacts={data.contacts} showHolder />
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function offLabel(why: string | null) {
  return why === "exit" ? "Off — left" : why === "account" ? "Off — account off" : "Off";
}

function PeopleTab({ data }: { data: CardsOverview }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [templateId, setTemplateId] = useState(data.templates.find((t) => t.isDefault)?.id ?? data.templates[0]?.id ?? "");
  const [groupKind, setGroupKind] = useState<"department" | "branch" | "role">("department");
  const [groupId, setGroupId] = useState("");
  const [filter, setFilter] = useState<"all" | "with" | "without">("all");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const rows = useMemo(
    () =>
      data.rows
        .filter((r) => r.accountActive || r.card)
        .filter((r) => (filter === "with" ? r.card?.active : filter === "without" ? !r.card?.active : true))
        .sort((a, b) => (b.card?.leads ?? -1) - (a.card?.leads ?? -1) || a.name.localeCompare(b.name)),
    [data.rows, filter],
  );
  const groups =
    groupKind === "department"
      ? data.departments.map((d) => ({ id: d.id, name: d.name }))
      : groupKind === "branch"
        ? data.branches.map((b) => ({ id: b.id, name: b.name }))
        : data.roles.map((r) => ({ id: r.key, name: r.name }));

  function issue(target: Parameters<typeof issueCards>[0]) {
    setError(null);
    setNotice(null);
    start(async () => {
      const result = await issueCards(target);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const { issued, reissued, skipped } = result.data;
      setNotice(
        [
          `${issued} card${issued === 1 ? "" : "s"} issued`,
          reissued ? `${reissued} switched back on` : null,
          skipped.length ? `skipped ${skipped.map((s) => `${s.name} (${s.why})`).join(", ")}` : null,
        ]
          .filter(Boolean)
          .join("; ") + ".",
      );
      setSelected(new Set());
      router.refresh();
    });
  }

  function toggle(userId: string, active: boolean) {
    setError(null);
    setNotice(null);
    start(async () => {
      const result = await setCardActive(userId, active);
      if (!result.ok) setError(result.error);
      router.refresh();
    });
  }

  const allIds = rows.filter((r) => r.accountActive).map((r) => r.userId);
  return (
    <div className="space-y-3">
      {data.mayManage && (
        <Card>
          <CardContent className="flex flex-wrap items-end gap-3 py-3">
            <div className="space-y-1">
              <Label htmlFor="issue-template">Template</Label>
              <Select id="issue-template" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                {data.templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                    {t.isDefault ? " (default)" : ""}
                  </option>
                ))}
              </Select>
            </div>
            <Button type="button" size="sm" disabled={pending || selected.size === 0 || !templateId} onClick={() => issue({ templateId, target: { kind: "people", ids: [...selected] } })}>
              Issue to {selected.size || "selected"}
            </Button>
            <span className="text-xs text-subtle">or a whole</span>
            <Select aria-label="Group" value={groupKind} onChange={(e) => { setGroupKind(e.target.value as typeof groupKind); setGroupId(""); }}>
              <option value="department">department</option>
              <option value="branch">branch</option>
              <option value="role">role</option>
            </Select>
            <Select aria-label="Which" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
              <option value="">Choose…</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </Select>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={pending || !groupId || !templateId}
              onClick={() => issue({ templateId, target: groupKind === "role" ? { kind: "role", key: groupId } : { kind: groupKind, id: groupId } })}
            >
              Issue to all of them
            </Button>
            <p className="w-full text-xs text-subtle">
              Issuing moves anybody who already has a card to this template and switches it back on, and lets them open My card. People who have left are skipped.
            </p>
          </CardContent>
        </Card>
      )}
      <div aria-live="polite">
        {error && <ActionNotice tone="error">{error}</ActionNotice>}
        {!error && notice && <ActionNotice tone="success">{notice}</ActionNotice>}
      </div>
      <div className="flex items-center gap-2">
        <Select aria-label="Show" value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
          <option value="all">Everybody</option>
          <option value="with">With a live card</option>
          <option value="without">Without one</option>
        </Select>
        <span className="text-xs text-subtle">Sorted by leads, most first.</span>
      </div>
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-subtle">
                {data.mayManage && (
                  <th className="w-8 py-2 pl-4">
                    <input
                      type="checkbox"
                      aria-label="Select everybody shown"
                      checked={allIds.length > 0 && allIds.every((id) => selected.has(id))}
                      onChange={(e) => setSelected(e.target.checked ? new Set(allIds) : new Set())}
                    />
                  </th>
                )}
                <th className="py-2 pl-4 pr-3 font-medium">Person</th>
                <th className="py-2 pr-3 font-medium">Card</th>
                <th className="py-2 pr-3 text-right font-medium">Views (7d)</th>
                <th className="py-2 pr-3 text-right font-medium">Saves (7d)</th>
                <th className="py-2 pr-3 text-right font-medium">Leads</th>
                {data.mayManage && <th className="py-2 pr-4 text-right font-medium" />}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.userId} className="border-b border-line">
                  {data.mayManage && (
                    <td className="py-2 pl-4">
                      {r.accountActive && (
                        <input
                          type="checkbox"
                          aria-label={`Select ${r.name}`}
                          checked={selected.has(r.userId)}
                          onChange={(e) =>
                            setSelected((s) => {
                              const next = new Set(s);
                              if (e.target.checked) next.add(r.userId);
                              else next.delete(r.userId);
                              return next;
                            })
                          }
                        />
                      )}
                    </td>
                  )}
                  <td className="py-2 pl-4 pr-3">
                    <span className="block text-text">{r.name}</span>
                    <span className="block text-xs text-muted">{[r.jobTitle, r.departmentName].filter(Boolean).join(" · ") || r.email}</span>
                  </td>
                  <td className="py-2 pr-3">
                    {!r.card ? (
                      <span className="text-muted">—</span>
                    ) : r.card.active ? (
                      <a href={`${data.origin}/c/${r.card.slug}`} target="_blank" rel="noopener noreferrer" className="hover:underline">
                        <Badge tone="green">Live</Badge> <span className="text-xs text-muted">/c/{r.card.slug}</span>
                      </a>
                    ) : (
                      <Badge>{offLabel(r.card.switchedOffWhy)}</Badge>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums text-text">{r.card ? r.card.week.views : ""}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-text">{r.card ? r.card.week.saves : ""}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-text">{r.card ? r.card.leads : ""}</td>
                  {data.mayManage && (
                    <td className="py-2 pr-4 text-right">
                      {r.card && (
                        <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => toggle(r.userId, !r.card!.active)}>
                          {r.card.active ? "Switch off" : "Switch on"}
                        </Button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

type Draft = {
  id?: string;
  name: string;
  accentColor: string;
  coverColor: string;
  showLogo: boolean;
  fields: TemplateField[];
  questions: string[];
  makeDefault: boolean;
  cards: number;
};

function draftOf(t: CardTemplateRow | null): Draft {
  if (!t) return { name: "", accentColor: "#2563eb", coverColor: "#0f172a", showLogo: true, fields: defaultTemplateFields(), questions: [], makeDefault: false, cards: 0 };
  return { id: t.id, name: t.name, accentColor: t.accentColor, coverColor: t.coverColor, showLogo: t.showLogo, fields: t.fields, questions: t.questions, makeDefault: t.isDefault, cards: t.cards };
}

const KIND_HINT = { record: "From their record", shared: "One value for everyone", own: "Their own" } as const;

function TemplatesTab({ templates }: { templates: CardTemplateRow[] }) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function save() {
    if (!draft) return;
    setError(null);
    start(async () => {
      const { cards: _cards, ...input } = draft;
      void _cards;
      const result = await saveCardTemplate({ ...input, questions: draft.questions.filter((q) => q.trim()) });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNotice(result.data.cards ? `Saved — ${result.data.cards} card${result.data.cards === 1 ? "" : "s"} show it now.` : "Saved.");
      setDraft(null);
      router.refresh();
    });
  }

  function remove(id: string) {
    setError(null);
    start(async () => {
      const result = await deleteCardTemplate(id);
      if (!result.ok) setError(result.error);
      else setNotice("Deleted.");
      router.refresh();
    });
  }

  function move(i: number, by: -1 | 1) {
    setDraft((d) => {
      if (!d) return d;
      const fields = [...d.fields];
      const j = i + by;
      if (j < 0 || j >= fields.length) return d;
      [fields[i], fields[j]] = [fields[j]!, fields[i]!];
      return { ...d, fields };
    });
  }

  function setField(i: number, patch: Partial<TemplateField>) {
    setDraft((d) => (d ? { ...d, fields: d.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) } : d));
  }

  return (
    <div className="space-y-3">
      <div aria-live="polite">
        {error && <ActionNotice tone="error">{error}</ActionNotice>}
        {!error && notice && <ActionNotice tone="success">{notice}</ActionNotice>}
      </div>
      {!draft && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {templates.map((t) => (
              <Card key={t.id}>
                <div className="h-10 rounded-t-xl" style={{ backgroundColor: t.coverColor }} />
                <CardContent className="space-y-2 py-3">
                  <div className="flex items-center gap-2">
                    <span className="h-3 w-3 rounded-full" style={{ backgroundColor: t.accentColor }} aria-hidden />
                    <span className="font-medium text-text">{t.name}</span>
                    {t.isDefault && <Badge tone="blue">Default</Badge>}
                  </div>
                  <p className="text-xs text-muted">
                    {t.cards} card{t.cards === 1 ? "" : "s"} · {t.fields.filter((f) => f.on).length} fields · {t.questions.length} question{t.questions.length === 1 ? "" : "s"}
                  </p>
                  <div className="flex gap-2">
                    <Button type="button" size="sm" variant="secondary" onClick={() => { setNotice(null); setDraft(draftOf(t)); }}>
                      Edit
                    </Button>
                    {!t.isDefault && t.cards === 0 && (
                      <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => remove(t.id)}>
                        Delete
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
          <Button type="button" size="sm" onClick={() => { setNotice(null); setDraft(draftOf(null)); }}>
            New template
          </Button>
        </>
      )}

      {draft && (
        <Card>
          <CardContent className="space-y-4 py-4">
            <h2 className="text-sm font-semibold text-text">{draft.id ? `Edit ${draft.name}` : "New template"}</h2>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="tpl-name">Name</Label>
                <Input id="tpl-name" value={draft.name} maxLength={60} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Sales team" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tpl-accent">Accent colour</Label>
                <Input id="tpl-accent" type="color" value={draft.accentColor} onChange={(e) => setDraft({ ...draft, accentColor: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tpl-cover">Cover colour</Label>
                <Input id="tpl-cover" type="color" value={draft.coverColor} onChange={(e) => setDraft({ ...draft, coverColor: e.target.value })} />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-text">
              <input type="checkbox" checked={draft.showLogo} onChange={(e) => setDraft({ ...draft, showLogo: e.target.checked })} />
              Show the company logo (the letterhead logo, from Settings)
            </label>
            <label className="flex items-center gap-2 text-sm text-text">
              <input type="checkbox" checked={draft.makeDefault} onChange={(e) => setDraft({ ...draft, makeDefault: e.target.checked })} />
              Default template for new cards
            </label>

            <fieldset>
              <legend className="text-sm font-medium text-text">Fields, in the order the card shows them</legend>
              <p className="text-xs text-muted">
                Locked: from the record, people can&apos;t hide it; shared, they can&apos;t put their own in its place; their own, the card doesn&apos;t offer it. A personal phone or email never appears unless people add it themselves.
              </p>
              <ul className="mt-2 divide-y divide-line rounded-base border border-line">
                {draft.fields.map((f, i) => {
                  const def = CARD_FIELDS.find((d) => d.key === f.key)!;
                  return (
                    <li key={f.key} className="flex flex-wrap items-center gap-3 px-3 py-2">
                      <label className="flex min-w-[12rem] flex-1 items-center gap-2 text-sm text-text">
                        <input type="checkbox" checked={f.on} onChange={(e) => setField(i, { on: e.target.checked })} />
                        {def.label}
                        <span className="text-xs text-subtle">{KIND_HINT[def.kind]}</span>
                      </label>
                      {def.kind === "shared" && (
                        <Input
                          aria-label={`${def.label} value`}
                          className="max-w-xs"
                          value={f.value ?? ""}
                          maxLength={200}
                          onChange={(e) => setField(i, { value: e.target.value })}
                          placeholder={def.key === "website" ? "www.example.com" : ""}
                        />
                      )}
                      <Button type="button" size="sm" variant="ghost" aria-pressed={f.locked} onClick={() => setField(i, { locked: !f.locked })} title={f.locked ? "Locked" : "Open"}>
                        {f.locked ? <Lock className="h-4 w-4" aria-hidden /> : <Unlock className="h-4 w-4" aria-hidden />}
                        <span className="sr-only">{f.locked ? `Unlock ${def.label}` : `Lock ${def.label}`}</span>
                      </Button>
                      <Button type="button" size="sm" variant="ghost" onClick={() => move(i, -1)} disabled={i === 0}>
                        <ArrowUp className="h-4 w-4" aria-hidden />
                        <span className="sr-only">Move {def.label} up</span>
                      </Button>
                      <Button type="button" size="sm" variant="ghost" onClick={() => move(i, 1)} disabled={i === draft.fields.length - 1}>
                        <ArrowDown className="h-4 w-4" aria-hidden />
                        <span className="sr-only">Move {def.label} down</span>
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </fieldset>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-text">Questions when somebody shares back (up to {MAX_QUESTIONS}, never required)</legend>
              {Array.from({ length: MAX_QUESTIONS }, (_, i) => (
                <Input
                  key={i}
                  aria-label={`Question ${i + 1}`}
                  value={draft.questions[i] ?? ""}
                  maxLength={120}
                  placeholder={i === 0 ? "What are you interested in?" : ""}
                  onChange={(e) => {
                    const questions = [...draft.questions];
                    while (questions.length <= i) questions.push("");
                    questions[i] = e.target.value;
                    setDraft({ ...draft, questions });
                  }}
                />
              ))}
            </fieldset>

            {draft.id && draft.cards > 0 && (
              <ActionNotice tone="info">
                {draft.cards} card{draft.cards === 1 ? "" : "s"} use this template and will change as soon as you save.
              </ActionNotice>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" size="sm" variant="secondary" onClick={() => setDraft(null)} disabled={pending}>
                Cancel
              </Button>
              <Button type="button" size="sm" onClick={save} disabled={pending || draft.name.trim().length < 2}>
                {pending ? "Saving…" : "Save template"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
