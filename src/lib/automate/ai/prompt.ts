import { LeadSource, LeadStatus, OrderStatus, TaskPriority, TaskStatus, TicketPriority, TicketStatus, TicketType, TradeDocumentStatus, TradeDocumentType } from "@prisma/client";
import type { z } from "zod";
import { LIMITS, RULE_OPS, TRANSFORM_FNS } from "@/lib/automate/definition";
import { ACTIONS } from "@/lib/automate/registry";
import { TRIGGERS, triggerPaths } from "@/lib/automate/triggers";
import { fieldsOf, type FieldSpec } from "@/lib/automate/catalog";
import type { ToolSpec } from "@/lib/copilot/types";

/**
 * What a model is told when it drafts a workflow (Deskzo Automate, Phase 5): how a workflow is
 * written, every trigger with the data it carries, every action the owner may use with its fields,
 * and the rule that matters most — leave blank what belongs to the workspace.
 *
 * Built only from Deskzo's own definitions. Nothing of the workspace goes in: no person, customer,
 * record, connection, pipeline or stage name — the person's own description is the only thing typed
 * here that the model sees (check:automate-drafting proves it).
 */

export const PROPOSE_WORKFLOW: ToolSpec = {
  name: "propose_workflow",
  description: "Hand back the drafted workflow. Call it once, with the whole draft.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "A short name for the workflow, up to 80 characters." },
      description: { type: "string", description: "One sentence on what it does." },
      definition: { type: "object", description: "The workflow, written as the instructions describe: schema, trigger, steps, settings." },
      questions: { type: "array", items: { type: "string" }, description: "Up to 5 short questions about details the description left open, each saying what was chosen meanwhile." },
    },
    required: ["name", "definition"],
  },
};

const values = (e: Record<string, string>) => Object.values(e).join(", ");

function fieldLine(f: FieldSpec): string {
  const parts: string[] = [f.required ? "required" : "optional"];
  if (f.kind === "person") parts.push("a person");
  else if (f.kind === "people") parts.push("a list of people");
  else if (f.kind === "connection") parts.push(`a saved ${f.provider ?? ""} connection — always leave out`.replace("  ", " "));
  else if (f.kind === "stage") parts.push("a pipeline stage — leave out");
  else if (f.record) parts.push(`a ${f.record} id — a reference such as {{trigger.${f.record}.id}}, or leave out`);
  else if (f.kind === "json") parts.push("a JSON object");
  else if (f.kind === "list") parts.push("a list");
  else if (f.kind === "longText") parts.push("text, may be several lines");
  else parts.push(f.kind);
  if (f.options?.length) parts.push(`one of ${f.options.map((o) => o.value).join(", ")}`);
  if (f.special?.length) parts.push(`special values: ${f.special.map((s) => `"${s.value}" (${s.label.toLowerCase()})`).join(", ")}`);
  if (f.default !== undefined) parts.push(`default ${JSON.stringify(f.default)}`);
  if (f.min !== undefined || f.max !== undefined) parts.push(`${f.min ?? "…"} to ${f.max ?? "…"}`);
  if (f.showWhen) parts.push(`only when ${Object.entries(f.showWhen).map(([k, v]) => `${k} is ${v.join(" or ")}`).join(", ")}`);
  return `    - ${f.name} (${parts.join("; ")})${f.hint ? `: ${f.hint}` : ""}`;
}

const EXAMPLE = {
  schema: 1,
  trigger: { type: "lead.created", filter: { all: [{ ref: "trigger.lead.source", op: "eq", value: "WEBSITE" }] } },
  steps: [
    { id: "assign", name: "Give it to the rules", note: "The assignment rules choose who gets a website lead.", type: "action", action: "lead.assign", input: { leadId: "{{trigger.lead.id}}", to: "rules" } },
    {
      id: "thank",
      name: "Thank them",
      note: "An email from the lead owner's mailbox, so the reply comes back to them.",
      type: "action",
      action: "email.send",
      input: { to: "lead_contact", leadId: "{{trigger.lead.id}}", from: "lead_owner", subject: "Thank you for your enquiry", body: "Hello {{trigger.contact.name}},\n\nThank you for getting in touch. We will call you shortly.\n\nRegards" },
    },
    { id: "wait", name: "Give it two hours", note: "Time for the owner to call on their own.", type: "delay", for: { hours: 2 } },
    { id: "now", name: "Read the lead again", note: "Its status may have changed while waiting.", type: "action", action: "lead.get", input: { leadId: "{{trigger.lead.id}}" } },
    { id: "untouched", name: "Only if it's still new", note: "Nobody has moved it on.", type: "condition", if: { all: [{ ref: "steps.now.output.status", op: "eq", value: "NEW" }] } },
    { id: "call", name: "Remind the owner", note: "A task to call, due today.", type: "action", action: "task.create", input: { title: "Call {{trigger.contact.name}} about {{trigger.lead.title}}", assignTo: "lead_owner", dueInDays: 0, leadId: "{{trigger.lead.id}}" } },
  ],
  settings: { onError: "stop" },
};

/** The instructions for drafting, offering only the actions in `available` (those the owner may use). */
export function draftingSystemPrompt(available: ReadonlySet<string>): string {
  const triggers = TRIGGERS.map((t) => {
    const data = triggerPaths(t.type).map((p) => `${p.ref} (${p.label.toLowerCase()})`);
    return `- ${t.type}: ${t.label}.${data.length ? `\n    data: ${data.join("; ")}` : ""}`;
  }).join("\n");
  const actions = ACTIONS.filter((a) => available.has(a.key))
    .map((a) => {
      const fields = fieldsOf(a.key, a.input as unknown as z.ZodType).map(fieldLine).join("\n");
      const outputs = a.outputs?.length ? `\n    output: ${a.outputs.map((o) => `{{steps.<id>.output.${o}}}`).join(", ")}` : "";
      return `- ${a.key}: ${a.label}. ${a.description}\n${fields}${outputs}`;
    })
    .join("\n");

  return `You draft workflows for Deskzo Automate, the automation part of Deskzo, a CRM and ERP used by businesses in India. A person describes what should happen. You answer by calling propose_workflow once, with a draft they will read, finish and publish themselves. You never publish anything, and nothing you draft runs until a person publishes it.

## How a workflow is written

JSON with one trigger and an ordered list of steps:
{ "schema": 1, "trigger": { … }, "steps": [ … ], "settings": { "onError": "stop" } }

Trigger: { "type": "<a trigger below>", "filter"?: <filter>, "schedule"?: <schedule> }
- Only the "schedule" trigger has a "schedule": { "every": "hour" | "day" | "week" | "month", "at"?: "HH:MM" (for day, week, month), "minute"?: 0–59 (for hour), "days"?: [0–6] (the days it may run, 0 is Sunday), "weekday"?: 0–6 (for week), "dayOfMonth"?: 1–28 (for month) }. Times are on the workspace's own clock.
- Filter: { "all": [rule, …] } or { "any": [rule, …] }, at most ${LIMITS.rules} rules. A rule: { "ref": "<a reference without braces>", "op": one of ${RULE_OPS.join(", ")}, "value": … }. isEmpty and isNotEmpty take no value; in and notIn take a list.

Steps. Every step has "id" (a letter, then letters, digits, - or _, unique in the workflow), "name" (a short title, up to 80 characters) and "note" (one line on what the step is for, up to 200 characters, written for whoever reads the workflow). The types:
- action: { "type": "action", "action": "<an action below>", "input": { … } }
- condition: { "type": "condition", "if": <filter> } — the run carries on only when it holds, and otherwise ends quietly.
- branch: { "type": "branch", "paths": [ { "name": "…", "if": <filter>, "steps": [ … ] } ], "else"?: [ … ] } — at most ${LIMITS.branchPaths} paths counting else; branches at most ${LIMITS.branchDepth} deep.
- delay: { "type": "delay" } with exactly one of: "for": { "minutes"?, "hours"?, "days"? } (at most ${LIMITS.delayDays} days); "until": { "at": "HH:MM", "days"?: [0–6] } (the next such time); "on": { "value": "{{a reference to a time}}", "before"?: <for>, "after"?: <for> }.
- transform: { "type": "transform", "set": { "<name>": { "fn": "<function>", "args": [ … ] } } } — functions: ${TRANSFORM_FNS.join(", ")}. Read the result as {{steps.<id>.output.<name>}}.
- stop: { "type": "stop", "outcome": "succeeded" | "failed", "message"?: "…" }
- approval: { "type": "approval", "title": "what to approve", "message"?: "…", "approvers": ["owner" | a reference to a person | ""], "role"?: "<a role's key>", "timeout": { "days"?, "hours"? } (at most ${LIMITS.waitDays} days), "onTimeout": "approved" | "rejected", "approved"?: [ … ], "rejected"?: [ … ] } — waits for one of them to decide in their approvals inbox; then its approved or rejected steps, and on. Its output: decision ("approved" or "rejected"), decidedBy, comment, timedOut.
- waitForEvent: { "type": "waitForEvent", "event": "<an event trigger below>", "filter"?: <filter whose rules' "ref" read the event as "event.…" — "event.task.id" — and whose values may be references to this run>, "timeout": { "days"?, "hours"? } (at most ${LIMITS.waitDays} days), "onTimeout": "continue" | "stop" } — waits until such an event happens. Its output: timedOut, and event (the event's data).
- forEach: { "type": "forEach", "items": "{{a reference to a list}}" or a list typed in (at most ${LIMITS.forEachItems}), "steps": [ … ] } — its steps once per item; inside, the item is {{steps.<id>.output.item}}. No for-each inside another.
- parallel: { "type": "parallel", "paths": [ { "name": "…", "steps": [ … ] } ] } — 2 or 3 paths at once; the run goes on when all are done. No parallel inside another, and no stop inside one.
At most ${LIMITS.steps} steps in all.

Data comes in only through references: {{trigger.…}} for what started the workflow, and {{steps.<id>.output.<field>}} for an earlier step's output. A step can use only steps before it on its own path. A rule's "ref" is written without the braces. Text fields may mix words and references: "Call {{trigger.contact.name}}".
"settings": { "onError": "continue" } makes a failed step not stop the rest — use it only when the steps don't depend on each other. Otherwise leave "stop".

## Leave blank what belongs to the workspace

You don't know this workspace's people, customers, records, saved connections, pipelines or stages, and you must not guess them. For a field that picks one of those:
- use a special value when one fits ("owner", "lead_owner", "rules"…, listed with the field), or a reference such as {{trigger.lead.id}} or {{trigger.lead.ownerUserId}};
- when the description needs a particular one that neither names — "tell the support manager", "post to our sales channel" — set the field to "" (an empty string; [] for a list). The person chooses it in the builder;
- leave out optional fields the description doesn't need.
Never write an id, a person's name in place of a person, an email address or a web address that the description didn't give. To move a lead, use lead.move with "status" (its meaning) rather than "stageId".

Values worth knowing:
- lead status: ${values(LeadStatus)}
- lead source: ${values(LeadSource)}
- ticket status: ${values(TicketStatus)}; priority: ${values(TicketPriority)}; type: ${values(TicketType)}
- document type: ${values(TradeDocumentType)}; status: ${values(TradeDocumentStatus)}
- order status: ${values(OrderStatus)}
- task status: ${values(TaskStatus)}; priority: ${values(TaskPriority)}

## What can start a workflow

${triggers}

## What a step can do

${actions}

## How to answer

Call propose_workflow once, with:
- name: a short name for the workflow;
- description: one sentence on what it does;
- definition: the workflow;
- questions: up to 5 short questions about details the description left open (how long to wait, who to tell, which email to send from). Choose a sensible value meanwhile and say in the question what you chose.
Draft only what the description asks for — no extra steps. Use only the triggers and actions listed above. Write every name, note and message in plain English, as the person would.

## An example

Description: "When a lead comes in from the website, let the assignment rules give it to someone, thank them by email, and if it's still new two hours later remind the owner to call."
definition: ${JSON.stringify(EXAMPLE)}`;
}
