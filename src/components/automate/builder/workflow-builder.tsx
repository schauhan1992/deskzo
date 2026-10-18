"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, BadgeCheck, Columns3, Copy, GitBranch, Hourglass, MoreHorizontal, Octagon, Plus, Radio, Repeat, Trash2, Filter as FilterIcon, Zap, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "@/components/ui/menu";
import { StatusBadge } from "@/components/automate/status-badge";
import {
  duplicateAutomationWorkflow,
  exportAutomationWorkflow,
  publishAutomationWorkflow,
  restoreAutomationVersion,
  takeOverAutomationWorkflow,
  saveAsCompanyTemplate,
  saveWorkflowDraft,
  setAutomationWorkflowStatus,
  testWorkflowDraft,
  type BuilderWorkflow,
  type RunDetail,
} from "@/actions/automate";
import { childLists, mapChildLists, type Step } from "@/lib/automate/definition";
import type { ActionSpec, Catalog } from "@/lib/automate/catalog";
import type { DefinitionProblem } from "@/lib/automate/validate";
import { runPath, runRef, workflowRef } from "@/lib/automate/refs";
import { StepForm, TriggerForm } from "@/components/automate/builder/step-forms";
import { ROOT, cloneStep, dataBefore, findStep, insertStep, moveStep, newStepId, readDraft, removeStep, updateStep, type Draft, type Slot } from "@/components/automate/builder/tree";

/**
 * The builder (Deskzo Automate, Phase 3): a workflow as a vertical list of cards — what starts it at
 * the top, the steps running down — with a + between any two to add a step there, and branches'
 * paths side by side. Clicking a card opens its form beside the list (under the card on a phone).
 *
 * The draft is saved as it is edited, and the problems publishing would raise come back with each
 * save and show on their cards. Test runs it on a real recent record without doing anything but the
 * reads (and the safe steps, when asked); Publish makes it the version that runs.
 */

const MODULE_GROUPS: Record<string, string> = {
  leads: "Leads",
  helpdesk: "Tickets",
  companies: "Email",
  sales_documents: "Documents",
  calendar: "Meetings",
  reports: "Reports",
  tasks: "Tasks",
  notifications: "Notifications",
};

type Selected = "trigger" | string | null;

const rulesText = (n: number) => `${n} rule${n === 1 ? "" : "s"} hold${n === 1 ? "s" : ""}`;

/** A card's two lines: what kind of step, and what this one does. */
function describe(step: Step, catalog: Catalog): { title: string; detail: string } {
  switch (step.type) {
    case "action": {
      const action = catalog.actions.find((a) => a.key === step.action);
      const input = step.input as Record<string, unknown>;
      const field = action?.fields.find((f) => ["title", "subject", "note", "name"].includes(f.name) && typeof input[f.name] === "string" && input[f.name]);
      const choice = action?.fields.find((f) => (f.options || f.special) && typeof input[f.name] === "string");
      const word = field ? `“${String(input[field.name]).slice(0, 60)}”` : choice ? ([...(choice.options ?? []), ...(choice.special ?? [])].find((o) => o.value === input[choice.name])?.label ?? "") : "";
      return { title: action?.label ?? step.action, detail: word };
    }
    case "condition": {
      const rules = "any" in step.if ? step.if.any : step.if.all;
      return { title: "Only carry on if", detail: rules.length ? rulesText(rules.length) : "no rules yet" };
    }
    case "branch":
      return { title: "Branch", detail: `${step.paths.length} path${step.paths.length === 1 ? "" : "s"}${step.else ? ", and otherwise" : ""}` };
    case "delay":
      if (step.on) return { title: "Wait", detail: `until ${step.on.value || "a time in the data"}${step.on.before?.hours ? `, ${step.on.before.hours} h before` : ""}` };
      if (step.until) return { title: "Wait", detail: `until ${step.until.at}` };
      return { title: "Wait", detail: [step.for?.days ? `${step.for.days} d` : null, step.for?.hours ? `${step.for.hours} h` : null, step.for?.minutes ? `${step.for.minutes} min` : null].filter(Boolean).join(" ") || "—" };
    case "stop":
      return { title: "End the run", detail: step.outcome === "succeeded" ? "as a success" : "as a failure" };
    case "transform":
      return { title: "Set values", detail: "" };
    case "approval": {
      const who = step.approvers.length + (step.role ? 1 : 0);
      return { title: "Ask for approval", detail: step.title ? `“${step.title.slice(0, 60)}”` : who ? "" : "nobody chosen yet" };
    }
    case "waitForEvent":
      return { title: "Wait for something to happen", detail: catalog.triggers.find((t) => t.type === step.event)?.label ?? step.event };
    case "forEach":
      return { title: "For each item", detail: Array.isArray(step.items) ? `${step.items.length} item${step.items.length === 1 ? "" : "s"} typed in` : step.items ? "of a list from the data" : "no list yet" };
    case "parallel":
      return { title: "At the same time", detail: `${step.paths.length} path${step.paths.length === 1 ? "" : "s"}` };
  }
}

const ICONS = { action: Zap, condition: FilterIcon, branch: GitBranch, delay: Hourglass, stop: Octagon, transform: Zap, approval: BadgeCheck, waitForEvent: Radio, forEach: Repeat, parallel: Columns3 } as const;

/** Hands the browser a file to save. */
function download(fileName: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** "Cleared for another workspace: …" — what an export or a company template left out. */
const clearedText = (cleared: string[]) => (cleared.length ? ` Cleared, as they belong to this workspace: ${cleared.slice(0, 4).join("; ")}${cleared.length > 4 ? ` and ${cleared.length - 4} more` : ""}.` : "");

/** A record field filled from what started it — a lead step on a lead trigger reads the lead. */
function prefill(action: ActionSpec, draft: Draft, catalog: Catalog): Record<string, unknown> {
  const paths = new Set(catalog.triggers.find((t) => t.type === draft.trigger.type)?.paths.map((p) => p.ref) ?? []);
  const input: Record<string, unknown> = {};
  for (const field of action.fields) {
    const ref = field.record ? `trigger.${field.record}.id` : null;
    if (ref && paths.has(ref)) input[field.name] = `{{${ref}}}`;
  }
  return input;
}

/**
 * `demo`: shown and edited, never saved, tested or published — for looking at a workflow without
 * changing it (a template before it is used). A workflow somebody else owns is shown read-only: it runs
 * as them, so only they change, test or publish it (owner, 18 Oct 2026); it can be duplicated or taken over.
 */
export function WorkflowBuilder({ workflow, demo = false }: { workflow: BuilderWorkflow; demo?: boolean }) {
  const router = useRouter();
  const { catalog } = workflow;
  // Somebody else's: looked at, never saved.
  const readOnly = !workflow.mine;
  const locked = demo || readOnly;
  const [draft, setDraft] = useState<Draft>(() => readDraft(workflow.draft));
  const [name, setName] = useState(workflow.name);
  const [description, setDescription] = useState(workflow.description ?? "");
  const [selected, setSelected] = useState<Selected>("trigger");
  const [problems, setProblems] = useState<DefinitionProblem[]>(workflow.problems);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "unsaved" | "failed">("saved");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [test, setTest] = useState<{ run: RunDetail | null; about: string | null } | null>(null);
  const [testing, setTesting] = useState(false);
  const [live, setLive] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const first = useRef(true);
  const pending = useRef<Promise<boolean> | null>(null);

  const save = useCallback(async (): Promise<boolean> => {
    setSaveState("saving");
    const result = await saveWorkflowDraft(workflow.id, draft, { name, description: description || null });
    if (!result.ok) {
      setSaveState("failed");
      setSaveError(result.error);
      return false;
    }
    setProblems(result.data.problems);
    setSaveError(null);
    setSaveState("saved");
    return true;
  }, [workflow.id, draft, name, description]);

  // Saved a moment after each change; Test and Publish wait for it.
  useEffect(() => {
    if (first.current || locked) {
      first.current = false;
      return;
    }
    setSaveState("unsaved");
    const timer = setTimeout(() => {
      pending.current = save();
    }, 900);
    return () => clearTimeout(timer);
  }, [save, locked]);

  const flush = async () => {
    if (saveState === "unsaved" || saveState === "failed") return save();
    if (pending.current) return pending.current;
    return true;
  };

  const step = selected && selected !== "trigger" ? findStep(draft, selected) : null;
  const data = useMemo(() => dataBefore(draft, selected === "trigger" ? null : selected, catalog), [draft, selected, catalog]);
  const problemsOf = (id: string | null) => problems.filter((p) => p.stepId === id);
  const testOf = (id: string) => test?.run?.steps.filter((s) => s.stepId === id).at(-1) ?? null;

  const add = (slot: Slot, index: number, make: () => Step) => {
    const made = make();
    setDraft((d) => insertStep(d, slot, index, made));
    setSelected(made.id);
  };

  const runTest = async () => {
    setTesting(true);
    setNotice(null);
    if (!(await flush())) {
      setTesting(false);
      return;
    }
    const result = await testWorkflowDraft(workflow.id, live);
    setTesting(false);
    if (!result.ok) {
      if (result.problems) setProblems(result.problems);
      setNotice({ kind: "error", text: result.error });
      return;
    }
    setTest(result.data);
  };

  const publish = async () => {
    setBusy(true);
    if (!(await flush())) {
      setBusy(false);
      return;
    }
    const result = await publishAutomationWorkflow(workflow.id, note);
    setBusy(false);
    if (!result.ok) {
      if (result.problems) setProblems(result.problems);
      setNotice({ kind: "error", text: result.error });
      setPublishOpen(false);
      return;
    }
    setPublishOpen(false);
    setNote("");
    setNotice({ kind: "ok", text: `Published as version ${result.data.number}. It runs from now on.` });
    router.refresh();
  };

  const act = async (work: () => Promise<{ ok: boolean; error?: string }>, done?: string) => {
    setBusy(true);
    const result = await work();
    setBusy(false);
    if (!result.ok) setNotice({ kind: "error", text: (result as { error: string }).error });
    else {
      if (done) setNotice({ kind: "ok", text: done });
      router.refresh();
    }
  };

  const form =
    selected === "trigger" ? (
      <fieldset disabled={readOnly} className="min-w-0">
        <TriggerForm draft={draft} onChange={setDraft} catalog={catalog} data={data} problems={problems.filter((p) => p.stepId === null)} workflowId={workflow.id} webhook={workflow.webhook} demo={locked} />
      </fieldset>
    ) : step ? (
      <fieldset disabled={readOnly} className="min-w-0">
        <StepForm step={step} onChange={(s) => setDraft((d) => updateStep(d, step.id, () => s))} catalog={catalog} data={data} problems={problemsOf(step.id)} />
      </fieldset>
    ) : null;

  // Render functions, not components: a component defined in here would be a new type on every
  // render, and its inputs would lose focus at every key pressed.
  const renderAddStep = (slot: Slot, index: number) => {
    if (readOnly) return null;
    const groups = [...new Set(catalog.actions.map((a) => MODULE_GROUPS[a.module] ?? "Other"))];
    return (
      <div className="flex justify-center py-1">
        <Menu label="Add a step here" icon={Plus} width={300} align="start">
          {(close) => (
            <div className="max-h-96 overflow-y-auto">
              {groups.map((g) => (
                <Fragment key={g}>
                  <MenuLabel>{g}</MenuLabel>
                  {catalog.actions
                    .filter((a) => (MODULE_GROUPS[a.module] ?? "Other") === g)
                    .map((a) => (
                      <MenuItem
                        key={a.key}
                        disabled={!a.available}
                        onClick={() => {
                          add(slot, index, () => ({ id: newStepId(draft, a.key.split(".").pop() ?? "step"), type: "action", action: a.key, input: prefill(a, draft, catalog) }));
                          close();
                        }}
                      >
                        <span className="block">{a.label}</span>
                        {!a.available && a.why && <span className="block text-xs text-subtle">{a.why}</span>}
                      </MenuItem>
                    ))}
                </Fragment>
              ))}
              <MenuSeparator />
              <MenuLabel>Flow</MenuLabel>
              <MenuItem onClick={() => (add(slot, index, () => ({ id: newStepId(draft, "check"), type: "condition", if: { all: [] } })), close())}>Only carry on if…</MenuItem>
              <MenuItem onClick={() => (add(slot, index, () => ({ id: newStepId(draft, "branch"), type: "branch", paths: [{ name: "Path 1", if: { all: [] }, steps: [] }], else: [] })), close())}>Branch into paths</MenuItem>
              <MenuItem onClick={() => (add(slot, index, () => ({ id: newStepId(draft, "wait"), type: "delay", for: { hours: 1 } })), close())}>Wait</MenuItem>
              <MenuItem onClick={() => (add(slot, index, () => ({ id: newStepId(draft, "stop"), type: "stop", outcome: "succeeded" })), close())}>End the run</MenuItem>
              <MenuSeparator />
              <MenuLabel>Waiting and repeating</MenuLabel>
              <MenuItem onClick={() => (add(slot, index, () => ({ id: newStepId(draft, "approve"), type: "approval", title: "", approvers: ["owner"], timeout: { days: 3 }, onTimeout: "rejected", approved: [], rejected: [] })), close())}>Ask for approval</MenuItem>
              <MenuItem onClick={() => (add(slot, index, () => ({ id: newStepId(draft, "wait_for"), type: "waitForEvent", event: "task.completed", timeout: { days: 7 }, onTimeout: "continue" })), close())}>Wait for something to happen</MenuItem>
              <MenuItem onClick={() => (add(slot, index, () => ({ id: newStepId(draft, "each"), type: "forEach", items: [], steps: [] })), close())}>For each item in a list</MenuItem>
              <MenuItem onClick={() => (add(slot, index, () => ({ id: newStepId(draft, "together"), type: "parallel", paths: [{ name: "Path 1", steps: [] }, { name: "Path 2", steps: [] }] })), close())}>Paths at the same time</MenuItem>
            </div>
          )}
        </Menu>
      </div>
    );
  };

  const renderCard = (s: Step, index: number, count: number) => {
    const Icon = ICONS[s.type];
    const mine = problemsOf(s.id);
    const result = testOf(s.id);
    const isSelected = selected === s.id;
    return (
      <div>
        <div
          role="button"
          tabIndex={0}
          onClick={() => setSelected(s.id)}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setSelected(s.id))}
          className={`rounded-lg border bg-surface p-3 shadow-sm transition-colors ${isSelected ? "border-brand ring-1 ring-brand" : mine.length ? "border-danger" : "border-line hover:border-line-strong"}`}
        >
          <div className="flex items-start gap-2">
            <Icon className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-text">{s.name || describe(s, catalog).title}</p>
              <p className="truncate text-xs text-muted">{s.name ? [describe(s, catalog).title, describe(s, catalog).detail].filter(Boolean).join(" · ") : describe(s, catalog).detail}</p>
              {s.note && <p className="mt-0.5 line-clamp-2 text-xs text-subtle">{s.note}</p>}
              {mine.length > 0 && <p className="mt-1 text-xs text-danger">{mine[0]!.message}{mine.length > 1 ? ` (+${mine.length - 1} more)` : ""}</p>}
              {result && (
                <p className={`mt-1 text-xs ${result.status === "SUCCEEDED" ? "text-success" : "text-danger"}`}>
                  Test: {result.status === "SUCCEEDED" ? String((result.output as { preview?: string } | null)?.preview ?? "done") : (result.error ?? result.status)}
                </p>
              )}
            </div>
            <div onClick={(e) => e.stopPropagation()} hidden={readOnly}>
              <Menu label={`More for ${s.name || s.id}`} icon={MoreHorizontal} width={200}>
                {(close) => (
                  <>
                    <MenuItem disabled={index === 0} onClick={() => (setDraft((d) => moveStep(d, s.id, -1)), close())}>
                      <ArrowUp className="mr-1 inline h-3.5 w-3.5" /> Move up
                    </MenuItem>
                    <MenuItem disabled={index === count - 1} onClick={() => (setDraft((d) => moveStep(d, s.id, 1)), close())}>
                      <ArrowDown className="mr-1 inline h-3.5 w-3.5" /> Move down
                    </MenuItem>
                    <MenuItem
                      onClick={() => {
                        const copy = cloneStep(draft, s);
                        setDraft((d) => insertAfter(d, s.id, copy));
                        setSelected(copy.id);
                        close();
                      }}
                    >
                      <Copy className="mr-1 inline h-3.5 w-3.5" /> Duplicate
                    </MenuItem>
                    <MenuItem
                      danger
                      onClick={() => {
                        setDraft((d) => removeStep(d, s.id));
                        if (selected === s.id) setSelected("trigger");
                        close();
                      }}
                    >
                      <Trash2 className="mr-1 inline h-3.5 w-3.5" /> Delete
                    </MenuItem>
                  </>
                )}
              </Menu>
            </div>
          </div>
        </div>
        {isSelected && form && <div className="mt-2 rounded-lg border border-line bg-surface-sunken p-3 lg:hidden">{form}</div>}
        {childLists(s).length > 0 && (
          <div className={`mt-2 grid gap-3 border-l-2 pl-3 md:grid-cols-2 ${s.type === "parallel" ? "border-brand" : "border-line"}`}>
            {childLists(s).map((list) => (
              <div key={list.path} className={`min-w-0 rounded-lg bg-surface-sunken p-2 ${s.type === "forEach" ? "md:col-span-2" : ""}`}>
                <p className="mb-1 text-xs font-medium text-muted">{list.label}</p>
                {renderList(list.steps, { branchId: s.id, path: list.path })}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  const renderList = (steps: Step[], slot: Slot): React.ReactNode => (
    <div>
      {renderAddStep(slot, 0)}
      {steps.map((s, i) => (
        <Fragment key={s.id}>
          {renderCard(s, i, steps.length)}
          {renderAddStep(slot, i + 1)}
        </Fragment>
      ))}
    </div>
  );

  const triggerSpec = catalog.triggers.find((t) => t.type === draft.trigger.type);
  const general = problems.filter((p) => p.stepId === null);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-xs text-subtle">
            <Link href="/automate/workflows" className="hover:underline">
              Workflows
            </Link>{" "}
            › {workflowRef(workflow.seq)}
          </p>
          <Input value={name} maxLength={120} readOnly={readOnly} onChange={(e) => setName(e.target.value)} className="h-10 text-lg font-semibold" aria-label="Workflow name" />
          <Input value={description} maxLength={500} readOnly={readOnly} onChange={(e) => setDescription(e.target.value)} placeholder="What it is for, in a line" className="text-sm" aria-label="What it is for" />
          <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <StatusBadge status={workflow.status} />
            {workflow.activeVersion !== null ? <span>Version {workflow.activeVersion} runs</span> : <span>Not published yet</span>}
            <span>· Runs as {workflow.ownerName}</span>
            {workflow.source === "MIGRATED" && <span>· Moved from a pipeline&apos;s automations</span>}
            {workflow.source === "AI" && <span>· Drafted by AI — read each step before publishing</span>}
            <span>· {saveState === "saving" ? "Saving…" : saveState === "unsaved" ? "Unsaved" : saveState === "failed" ? `Not saved: ${saveError}` : "Saved"}</span>
          </p>
          {workflow.pausedReason && <p className="text-xs text-warning">{workflow.pausedReason}</p>}
          {readOnly && !demo && (
            <div className="flex flex-wrap items-center gap-2 rounded-base bg-surface-sunken px-3 py-2 text-xs text-muted">
              <span>
                It runs as {workflow.ownerName}, so only they change, test or publish it. Duplicate it to make your own, or take it over — it becomes yours, off until
                you publish it.
              </span>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  if (!window.confirm(`Take this workflow over from ${workflow.ownerName}? It becomes yours and is switched off until you publish it. They are told.`)) return;
                  void act(() => takeOverAutomationWorkflow(workflow.id), "It's yours now. Publish it to switch it on.");
                }}
              >
                Take over
              </Button>
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label hidden={readOnly} className="flex items-center gap-1.5 text-xs text-muted" title="A task, a note on a lead, a notification: done for real on the test's record.">
            <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
            Do the safe steps for real
          </label>
          <Button variant="secondary" size="sm" disabled={testing} hidden={readOnly} onClick={runTest}>
            <Play className="h-3.5 w-3.5" /> {testing ? "Testing…" : "Test"}
          </Button>
          <Button size="sm" disabled={busy || problems.length > 0} hidden={readOnly} onClick={() => setPublishOpen(true)} title={problems.length ? "Fix the problems marked first" : undefined}>
            Publish
          </Button>
          <Menu label="More" width={240}>
            {(close) => (
              <>
                {workflow.status === "ACTIVE" && <MenuItem onClick={() => (act(() => setAutomationWorkflowStatus(workflow.id, "PAUSED"), "Paused."), close())}>Pause it</MenuItem>}
                {workflow.status !== "ACTIVE" && workflow.activeVersion !== null && <MenuItem onClick={() => (act(() => setAutomationWorkflowStatus(workflow.id, "ACTIVE"), "Switched on."), close())}>Switch it on</MenuItem>}
                <MenuItem onClick={() => (setVersionsOpen(true), close())}>Versions</MenuItem>
                <MenuItem
                  onClick={async () => {
                    close();
                    const copy = await duplicateAutomationWorkflow(workflow.id);
                    if (copy.ok) router.push(copy.data.path);
                    else setNotice({ kind: "error", text: copy.error });
                  }}
                >
                  Duplicate
                </MenuItem>
                <MenuItem
                  disabled={demo}
                  onClick={async () => {
                    close();
                    if (!(await flush())) return;
                    const file = await exportAutomationWorkflow(workflow.id);
                    if (!file.ok) return setNotice({ kind: "error", text: file.error });
                    download(file.data.fileName, file.data.text);
                    setNotice({ kind: "ok", text: `Exported as ${file.data.fileName}.${clearedText(file.data.cleared)}` });
                  }}
                >
                  Export as a file
                </MenuItem>
                <MenuItem
                  disabled={demo}
                  onClick={async () => {
                    close();
                    if (!(await flush())) return;
                    const saved = await saveAsCompanyTemplate(workflow.id);
                    if (!saved.ok) return setNotice({ kind: "error", text: saved.error });
                    setNotice({ kind: "ok", text: `Saved as one of your company's templates, under Templates.${clearedText(saved.data.cleared)}` });
                  }}
                >
                  Save as a company template
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  danger
                  disabled={readOnly}
                  onClick={async () => {
                    close();
                    if (!window.confirm("Archive this workflow? It stops for good; its runs stay in the history.")) return;
                    const done = await setAutomationWorkflowStatus(workflow.id, "ARCHIVED");
                    if (done.ok) router.push("/automate/workflows");
                    else setNotice({ kind: "error", text: done.error });
                  }}
                >
                  Archive
                </MenuItem>
              </>
            )}
          </Menu>
        </div>
      </div>

      {notice && <p className={`rounded-base px-3 py-2 text-sm ${notice.kind === "ok" ? "bg-success-bg text-success" : "bg-danger-bg text-danger"}`}>{notice.text}</p>}
      {problems.length > 0 && (
        <p className="rounded-base bg-warning-bg px-3 py-2 text-sm text-warning">
          {problems.length} thing{problems.length === 1 ? "" : "s"} to fix before it can be published{general.length ? `: ${general[0]!.message}` : " — marked on the steps."}
        </p>
      )}

      {test && (
        <div className="rounded-lg border border-line bg-surface p-3 text-sm">
          <p className="font-medium text-text">
            Test {test.run ? <Link href={runPath(test.run.seq)} className="text-brand hover:underline">{runRef(test.run.seq)}</Link> : null} —{" "}
            {test.about ? `on ${test.about}` : "no record of that kind yet, so on nothing"}
          </p>
          <p className="text-xs text-muted">
            {test.run?.status === "SUCCEEDED" ? "Went through." : test.run?.status === "FAILED" ? `Stopped: ${test.run.error ?? ""}` : (test.run?.status ?? "")} Steps it would have done are marked on their cards; nothing was done but the reads{live ? " and the safe steps" : ""}.
          </p>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0">
          <div
            role="button"
            tabIndex={0}
            onClick={() => setSelected("trigger")}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setSelected("trigger"))}
            className={`rounded-lg border bg-surface p-3 shadow-sm ${selected === "trigger" ? "border-brand ring-1 ring-brand" : general.length ? "border-danger" : "border-line hover:border-line-strong"}`}
          >
            <p className="text-xs font-medium uppercase tracking-wide text-subtle">Starts when</p>
            <p className="text-sm font-medium text-text">{triggerSpec?.label ?? draft.trigger.type}</p>
            {draft.trigger.filter && <p className="text-xs text-muted">Only when {rulesText(("any" in draft.trigger.filter ? draft.trigger.filter.any : draft.trigger.filter.all).length)}</p>}
          </div>
          {selected === "trigger" && form && <div className="mt-2 rounded-lg border border-line bg-surface-sunken p-3 lg:hidden">{form}</div>}
          <div className="mx-auto h-3 w-px bg-line" />
          {renderList(draft.steps, ROOT)}
          {draft.steps.length === 0 && <p className="text-center text-xs text-muted">Add the first step with the + above.</p>}
        </div>
        <aside className="hidden lg:block">
          <div className="sticky top-4 max-h-[calc(100vh-2rem)] overflow-y-auto rounded-lg border border-line bg-surface p-4">{form ?? <p className="text-sm text-muted">Choose a card to change it.</p>}</div>
        </aside>
      </div>

      <Dialog open={publishOpen} onClose={() => setPublishOpen(false)} title="Publish this workflow">
        <div className="space-y-3">
          <p className="text-sm text-muted">The draft becomes the version that runs, from now on. Runs already under way finish on the version they started with.</p>
          <div className="space-y-1">
            <Label>What changed (optional)</Label>
            <Input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="Reminder after 4 hours, not 2" />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setPublishOpen(false)}>
              Not now
            </Button>
            <Button disabled={busy} onClick={publish}>
              Publish
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog open={versionsOpen} onClose={() => setVersionsOpen(false)} title="Versions">
        {workflow.versions.length === 0 ? (
          <p className="text-sm text-muted">Nothing published yet.</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {workflow.versions.map((v) => (
              <li key={v.id} className="flex items-start justify-between gap-3 py-2">
                <div>
                  <p className="font-medium text-text">
                    Version {v.number}
                    {v.number === workflow.activeVersion ? " · runs now" : ""}
                  </p>
                  <p className="text-xs text-muted">
                    {new Date(v.publishedAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })} · {v.publishedBy}
                    {v.note ? ` · ${v.note}` : ""}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy || readOnly}
                  onClick={async () => {
                    const done = await restoreAutomationVersion(workflow.id, v.id);
                    if (done.ok) window.location.reload();
                    else setNotice({ kind: "error", text: done.error });
                  }}
                >
                  Back into the draft
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Dialog>
    </div>
  );
}

/** A step placed straight after another, in the same list. */
function insertAfter(draft: Draft, afterId: string, step: Step): Draft {
  const place = (list: Step[]): Step[] => {
    const at = list.findIndex((s) => s.id === afterId);
    if (at >= 0) return [...list.slice(0, at + 1), step, ...list.slice(at + 1)];
    return list.map((s) => mapChildLists(s, place));
  };
  return { ...draft, steps: place(draft.steps) as Draft["steps"] };
}
