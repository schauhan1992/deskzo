/**
 * The AI copilot — src/lib/copilot/.
 *
 * It never talks to a real provider: the adapter is swapped for a scripted fake before anything runs,
 * so no request leaves this machine, nothing is spent, and no data is sent anywhere.
 *
 *   · The promise it rests on: every tool, run as one person, sees only their accounts — search, a
 *     company, leads, a report, their tasks — and can't hang a task on somebody else's account.
 *   · Tool inputs are checked whatever the model sends; unknown tools and bad input are refused.
 *   · Each provider's conversion: tool ids made safe for Claude, Claude's own turns replayed as they
 *     came, OpenAI's tool messages, Gemini's function responses.
 *   · The loop: tools run as the person and fed back; text streamed; turns and tokens saved; the
 *     step cap; a refusal; the daily allowance; switched off, no key, no permission.
 *   · Privacy: a conversation is its owner's alone, and nothing works while viewing as somebody.
 *   · Drafts: confirmed through the app's own action, once; cancelled; not somebody else's.
 *   · Settings: admins only; keys encrypted and never read back; the model list; the endpoint's own
 *     checks, streamed end to end.
 *
 * Everything is named ZZCOP and removed in a finally; the settings row is put back as it was.
 *
 *   npm run check:copilot
 */
import "dotenv/config";
import Module from "node:module";
import type { ReactElement } from "react";
import { PrismaClient } from "@prisma/client";

let actorId = "";
let viewingAs = false;
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = () => ({ id: actorId, role: "SALES", name: NAMES[actorId] ?? "Zzcop", email: `x${MAIL}` });
    return {
      requireUser: async () => user(),
      currentUser: async () => (actorId ? user() : null),
      viewAsContext: async () => (viewingAs ? { user: { id: "someone", name: "Someone" }, actor: { id: actorId, name: "Admin" } } : null),
    };
  }
  if (request === "next/navigation") {
    return {
      notFound: () => {
        throw new Error("notFound");
      },
      redirect: (to: string) => {
        throw new Error(`redirect ${to}`);
      },
      useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {} }),
      useSearchParams: () => new URLSearchParams(),
      usePathname: () => "/",
    };
  }
  if (request === "@/lib/email") return { sendEmailNotification: async () => {} };
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = new PrismaClient();
const TAG = "ZZCOP";
const MAIL = "@zzprobe-copilot.invalid";
const NAMES: Record<string, string> = {};
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

async function cleanup() {
  const users = await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  const companies = await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const companyIds = companies.map((c) => c.id);
  await db.task.deleteMany({ where: { OR: [{ createdByUserId: { in: ids } }, { companyId: { in: companyIds } }] } });
  await db.stickyNote.deleteMany({ where: { ownerUserId: { in: ids } } });
  await db.lead.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.company.deleteMany({ where: { id: { in: companyIds } } });
  await db.copilotConversation.deleteMany({ where: { userId: { in: ids } } });
  await db.copilotUsage.deleteMany({ where: { userId: { in: ids } } });
  await db.notification.deleteMany({ where: { userId: { in: ids } } });
  await db.activityLog.deleteMany({ where: { userId: { in: ids } } }).catch(() => undefined);
  await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
  await db.userPermission.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
}

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const providers = require("../src/lib/copilot/providers") as typeof import("../src/lib/copilot/providers");
  type TurnRequest = import("../src/lib/copilot/types").TurnRequest;
  type TurnOutcome = import("../src/lib/copilot/types").TurnOutcome;
  type Turn = import("../src/lib/copilot/types").Turn;
  type ChatEvent = import("../src/lib/copilot/types").ChatEvent;

  // The fake: every turn is scripted, every request kept for inspection. Nothing leaves the machine.
  const requests: TurnRequest[] = [];
  let script: (req: TurnRequest, n: number) => Partial<TurnOutcome> = () => ({ text: "Hello." });
  providers.setTestProvider({
    async runTurn(req) {
      requests.push({ ...req, history: JSON.parse(JSON.stringify(req.history)) as Turn[] });
      const out = script(req, requests.length);
      for (const piece of (out.text ?? "").match(/[\s\S]{1,7}/g) ?? []) req.onText(piece);
      const toolCalls = out.toolCalls ?? [];
      return {
        text: out.text ?? "",
        toolCalls,
        native: out.native ?? null,
        usage: out.usage ?? { input: 1000, output: 200 },
        stop: out.stop ?? (toolCalls.length ? "tools" : "done"),
        model: "fake-model",
      };
    },
    async listModels() {
      return ["fake-b", "fake-a"];
    },
  });

  const tools = require("../src/lib/copilot/tools") as typeof import("../src/lib/copilot/tools");
  const agent = require("../src/lib/copilot/agent") as typeof import("../src/lib/copilot/agent");
  const actions = require("../src/actions/copilot") as typeof import("../src/actions/copilot");
  const anthropicAdapter = require("../src/lib/copilot/providers/anthropic") as typeof import("../src/lib/copilot/providers/anthropic");
  const openaiAdapter = require("../src/lib/copilot/providers/openai") as typeof import("../src/lib/copilot/providers/openai");
  const geminiAdapter = require("../src/lib/copilot/providers/gemini") as typeof import("../src/lib/copilot/providers/gemini");
  const { decryptSecret } = require("../src/lib/crypto") as typeof import("../src/lib/crypto");
  const { formatCompanyId } = require("../src/lib/order-id") as typeof import("../src/lib/order-id");
  const { indianToday } = tools;

  // ─────────────────────────────────────────────────────────────────────────────
  section("Each provider's conversation");

  const history: Turn[] = [
    { role: "user", text: "Find Acme" },
    { role: "assistant", text: "Looking.", toolCalls: [{ id: "call_abc.1", name: "search_companies", input: { query: "Acme" } }] },
    { role: "tool", results: [{ id: "call_abc.1", name: "search_companies", output: "[]", isError: false }] },
    { role: "note", text: "The user confirmed the task." },
  ];
  const claude = anthropicAdapter.messagesFor(history);
  const toolUse = (claude[1]!.content as { type: string; id?: string }[]).find((b) => b.type === "tool_use");
  const toolResult = (claude[2]!.content as { type: string; tool_use_id?: string }[])[0];
  ok("Claude: another provider's tool ids are made safe, the same on the call and its result", toolUse?.id === "call_abc_1" && toolResult?.tool_use_id === "call_abc_1");
  ok("  a note from the app is marked as not typed by the user", String(claude[3]!.content).startsWith("(From the app"));
  const native = [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text: "Looking." }];
  const replayed = anthropicAdapter.messagesFor([{ role: "user", text: "x" }, { role: "assistant", text: "Looking.", toolCalls: [], native: { provider: "ANTHROPIC", model: "m", content: native } }]);
  ok("  Claude's own turns go back exactly as they came — thinking included", JSON.stringify(replayed[1]!.content) === JSON.stringify(native));
  const gpt = openaiAdapter.messagesFor("SYS", history);
  ok("OpenAI: system first, tool calls as functions, one tool message per result", gpt[0]!.role === "system" && gpt[2]!.role === "assistant" && gpt[3]!.role === "tool" && (gpt[3] as { tool_call_id: string }).tool_call_id === "call_abc.1");
  const gem = geminiAdapter.contentsFor(history);
  ok("Gemini: the model's turn as function calls, results as function responses", gem[1]!.role === "model" && !!gem[1]!.parts?.[1]?.functionCall && !!gem[2]!.parts?.[0]?.functionResponse);

  // ─────────────────────────────────────────────────────────────────────────────
  section("The tools, as specified to every provider");

  const specs = tools.TOOL_NAMES;
  ok("every tool has its own name", new Set(specs).size === specs.length && specs.length >= 12, specs.join(", "));
  const spec = tools.toolSpec({ name: "x", description: "d", schema: (await import("zod")).z.object({ q: (await import("zod")).z.string() }), run: async () => ({ output: null, activity: "" }) } as never);
  ok("schemas go out as plain JSON Schema, without the $schema marker some providers reject", !("$schema" in spec.parameters) && spec.parameters.type === "object");
  const { usageDay } = require("../src/lib/copilot/settings") as typeof import("../src/lib/copilot/settings");
  const lateUtc = new Date("2026-09-25T20:00:00Z"); // 1:30 am on the 26th in India
  ok("today, as the model is told it, is India's date — month and all", indianToday(lateUtc) === "2026-09-26" && indianToday(new Date("2026-01-31T12:00:00Z")) === "2026-01-31", indianToday(lateUtc));
  ok("  and the allowance's day is the same calendar day", usageDay(lateUtc).toISOString() === "2026-09-26T00:00:00.000Z" && usageDay(new Date("2026-12-31T12:00:00Z")).toISOString() === "2026-12-31T00:00:00.000Z");
  ok("a tool answer too long to be worth its tokens is cut short and says so",tools.outputText({ big: "x".repeat(20_000) }).endsWith("narrow the question)"));

  const settingsLib = require("../src/lib/copilot/settings") as typeof import("../src/lib/copilot/settings");
  const original = await db.copilotSettings.findUnique({ where: { id: "global" } });
  /** The real settings row exactly as it was, timestamp and all — or none, if there was none. */
  const restore = async () => {
    if (original) await db.copilotSettings.upsert({ where: { id: original.id }, create: original, update: original });
    else await db.copilotSettings.deleteMany({ where: { id: "global" } });
  };
  await cleanup();
  try {
    const make = async (name: string, grants: Record<string, boolean>) => {
      const u = await db.user.create({
        data: {
          name: `Zzcop ${name}`,
          email: `${name.toLowerCase()}${MAIL}`,
          role: "SALES",
          passwordHash: "x".repeat(60),
          permissionGrants: { create: Object.entries(grants).map(([permission, allowed]) => ({ permission, allowed, reason: TAG })) },
        },
      });
      NAMES[u.id] = u.name;
      return u;
    };
    const views = { "leads.view": true, "contacts.view": true, "orders.view": true, "tickets.view": true, "companies.viewAll": false };
    const repA = await make("RepA", { ...views, "copilot.use": true });
    const repB = await make("RepB", { ...views, "copilot.use": true });
    const admin = await make("Admin", { ...views, "copilot.use": true, "settings.manage": true });
    const noCop = await make("NoCop", { ...views, "copilot.use": false });

    const company = (name: string, owner: string) => db.company.create({ data: { name: `${TAG} ${name}`, normalizedName: `${TAG} ${name}`.toLowerCase(), createdById: owner, ownerUserId: owner } });
    const A = await company("Alpha Traders", repA.id);
    const B = await company("Beta Traders", repB.id);
    await db.lead.create({ data: { companyId: A.id, title: `${TAG} Alpha renewal`, ownerUserId: repA.id, estimatedValue: 100000 } });
    await db.lead.create({ data: { companyId: B.id, title: `${TAG} Beta renewal`, ownerUserId: repB.id, estimatedValue: 900000 } });
    await db.task.create({ data: { title: `${TAG} Beta follow-up`, createdByUserId: repB.id, assignedToUserId: repB.id } });

    // ───────────────────────────────────────────────────────────────────────────
    section("It sees what the person sees — no more");

    const as = async (userId: string) => {
      actorId = userId;
      return tools.toolsFor();
    };
    const offeredA = await as(repA.id);
    const ctxA = { userId: repA.id, conversationId: "" };
    const run = (name: string, input: unknown) => tools.runTool(offeredA, ctxA, name, input);
    const found = JSON.stringify((await run("search_companies", { query: TAG })).output);
    ok("search finds the person's own account and not a colleague's", found.includes("Alpha Traders") && !found.includes("Beta Traders"), found.slice(0, 160));
    const theirs = await run("get_company", { ref: formatCompanyId(B.companySeq) });
    ok("a colleague's company, asked for by its number, is simply not there", theirs.isError && JSON.stringify(theirs.output).includes("can see"));
    const mine = await run("get_company", { ref: formatCompanyId(A.companySeq) });
    ok("  their own opens, with its lead", !mine.isError && JSON.stringify(mine.output).includes("Alpha renewal"));
    const leads = JSON.stringify((await run("list_leads", { search: TAG })).output);
    ok("the pipeline holds their lead only", leads.includes("Alpha renewal") && !leads.includes("Beta renewal"), leads.slice(0, 160));
    const tasks = JSON.stringify((await run("my_tasks", {})).output);
    ok("their tasks are theirs — a colleague's isn't listed", !tasks.includes("Beta follow-up"));

    const options = (await run("report_options", {})).output as { sources: { source: string; measures: { key: string }[]; dimensions: { key: string }[]; dateFields: { key: string }[] }[] };
    const leadSource = options.sources.find((s) => s.source === "leads");
    if (leadSource) {
      const today = indianToday();
      const report = await run("run_report", {
        title: "Leads today",
        source: "leads",
        measure: leadSource.measures[0]!.key,
        dimension: leadSource.dimensions[0]!.key,
        grain: "day",
        dateField: leadSource.dateFields[0]!.key,
        from: today,
        to: today,
      });
      const out = report.output as { records?: number };
      ok("a report counts their records only", out.records === 1, JSON.stringify(out).slice(0, 160));
      ok("  and is drawn in the chat", report.blocks?.[0]?.type === "report");
    } else {
      ok("the leads report is available to check scoping against", false, options.sources.map((s) => s.source).join());
    }

    const blocked = await run("propose_task", { title: "Call Beta", companyRef: formatCompanyId(B.companySeq) });
    ok("a task can't be drafted onto a colleague's account", blocked.isError, JSON.stringify(blocked.output));

    ok("an unknown tool is refused", (await run("drop_tables", {})).isError);
    ok("input that doesn't fit the schema is refused, with the reason", (await run("list_leads", { limit: 500 })).isError && JSON.stringify((await run("list_leads", { limit: 500 })).output).includes("limit"));
    ok("  and so are arguments a model sent as broken JSON", (await run("search_companies", { __unparseable: "{query:" })).isError);

    // ───────────────────────────────────────────────────────────────────────────
    section("Switched on — with a key that goes nowhere");

    // A made-up configuration, in memory — the real settings row, which somebody may be using right
    // now, is not touched by any of the chats below.
    const config = { enabled: true, provider: "ANTHROPIC" as const, model: "fake-model", dailyTokenLimit: 100_000, hasKey: { ANTHROPIC: true, OPENAI: false, GEMINI: false } };
    const keys: Partial<Record<"ANTHROPIC" | "OPENAI" | "GEMINI", string>> = { ANTHROPIC: "sk-ant-zzcop-not-a-key" };
    settingsLib.setTestSettings({ config, keys });

    const chat = async (userId: string, text: string, conversationId?: string | null) => {
      actorId = userId;
      const events: ChatEvent[] = [];
      let error = "";
      try {
        await agent.runCopilot({ userId, userName: NAMES[userId]!, role: "SALES", conversationId, text, appName: "Wroffy ERP", emit: (e) => events.push(e) });
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      return { events, error, id: (events.find((e) => e.type === "conversation") as { id: string } | undefined)?.id ?? null };
    };

    requests.length = 0;
    script = (_req, n) => (n === 1 ? { text: "Let me look.", toolCalls: [{ id: "t1", name: "search_companies", input: { query: TAG } }] } : { text: `Found **${formatCompanyId(A.companySeq)}**.` });
    const first = await chat(repA.id, "Find my traders");
    ok("a question runs: a tool, then the answer", !first.error && requests.length === 2, first.error);
    const toolTurn = requests[1]!.history.find((t) => t.role === "tool") as Extract<Turn, { role: "tool" }> | undefined;
    ok("  the tool ran as the person — the model was given their account and not the other", !!toolTurn && toolTurn.results[0]!.output.includes("Alpha") && !toolTurn.results[0]!.output.includes("Beta"));
    ok("  told who it is helping and today's date", requests[0]!.system.includes("Zzcop RepA") && requests[0]!.system.includes(indianToday()));
    ok("  offered the tools, the same list on every turn", requests[0]!.tools.map((t) => t.name).join() === requests[1]!.tools.map((t) => t.name).join() && requests[0]!.tools.some((t) => t.name === "propose_task"));
    const streamed = first.events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("");
    ok("the answer streamed as it was written, and what it looked at was shown", streamed.includes("Found") && first.events.some((e) => e.type === "block"));
    ok("  and it finished with the day's usage", first.events.at(-1)?.type === "done");
    const saved = await db.copilotMessage.findMany({ where: { conversationId: first.id! }, orderBy: { createdAt: "asc" }, select: { role: true } });
    ok("every turn is saved", saved.map((m) => m.role).join() === "user,assistant,tool,assistant", saved.map((m) => m.role).join());
    ok("the tokens are counted against today", (await db.copilotUsage.findFirst({ where: { userId: repA.id } }))?.requests === 2);

    requests.length = 0;
    script = () => ({ text: "That's the one." });
    const followUp = await chat(repA.id, "Thanks", first.id);
    ok("a follow-up carries the conversation", !followUp.error && requests[0]!.history.filter((t) => t.role === "user").length === 2);

    // ───────────────────────────────────────────────────────────────────────────
    section("Privacy");

    const stolen = await chat(repB.id, "What did they ask?", first.id);
    ok("somebody else can't continue a conversation", stolen.error.includes("isn't there"), stolen.error);
    actorId = repB.id;
    ok("  nor open it", (await actions.getCopilotConversation(first.id!)) === null);
    await actions.deleteCopilotConversation(first.id!);
    ok("  nor delete it", (await db.copilotConversation.count({ where: { id: first.id! } })) === 1);
    actorId = repA.id;
    const reopened = await actions.getCopilotConversation(first.id!);
    ok("its owner opens it, as the chat shows it", !!reopened && reopened.items[0]?.role === "user" && reopened.items[1]?.role === "assistant");
    viewingAs = true;
    ok("nothing opens while viewing as somebody — their chats would be on the screen", (await actions.getCopilotConversation(first.id!)) === null && (await actions.listCopilotConversations()).length === 0);
    viewingAs = false;

    // ───────────────────────────────────────────────────────────────────────────
    section("Drafts");

    requests.length = 0;
    script = (_req, n) =>
      n === 1
        ? { toolCalls: [{ id: "p1", name: "propose_task", input: { title: `${TAG} Call Alpha`, dueDate: "2026-12-01", companyRef: formatCompanyId(A.companySeq) } }] }
        : { text: "I've drafted it — press Create." };
    const drafted = await chat(repA.id, "Remind me to call Alpha");
    const card = drafted.events.find((e) => e.type === "block" && e.block.type === "proposal") as { block: { id: string; summary: string } } | undefined;
    ok("a task is drafted as a card, not created", !!card && (await db.task.count({ where: { title: `${TAG} Call Alpha` } })) === 0, card?.block.summary);
    actorId = repB.id;
    ok("somebody else can't confirm it", !(await actions.confirmCopilotProposal(card!.block.id)).ok);
    actorId = repA.id;
    const confirmed = await actions.confirmCopilotProposal(card!.block.id);
    const task = await db.task.findFirst({ where: { title: `${TAG} Call Alpha` } });
    ok("confirmed, it is created by the app's own action — as them, on their account", confirmed.ok && task?.createdByUserId === repA.id && task.companyId === A.id);
    const twice = await actions.confirmCopilotProposal(card!.block.id);
    ok("  and pressed twice, it is created once", !twice.ok && (await db.task.count({ where: { title: `${TAG} Call Alpha` } })) === 1);
    const shown = await actions.getCopilotConversation(drafted.id!);
    const shownCard = shown?.items.flatMap((i) => (i.role === "assistant" ? i.segments : [])).find((s) => s.kind === "block" && s.block.type === "proposal");
    ok("  the card shows it done, and the model is told", shownCard?.kind === "block" && shownCard.block.type === "proposal" && shownCard.block.status === "DONE" && shown!.items.some((i) => i.role === "note"));

    requests.length = 0;
    script = (_req, n) => (n === 1 ? { toolCalls: [{ id: "p2", name: "propose_note", input: { body: `${TAG} note`, companyRef: formatCompanyId(A.companySeq) } }] } : { text: "Drafted." });
    const noteDraft = await chat(repA.id, "Note that Alpha wants a quote");
    const noteCard = noteDraft.events.find((e) => e.type === "block" && e.block.type === "proposal") as { block: { id: string } } | undefined;
    await actions.cancelCopilotProposal(noteCard!.block.id);
    ok("a draft can be cancelled, and then can't be confirmed", !(await actions.confirmCopilotProposal(noteCard!.block.id)).ok && (await db.stickyNote.count({ where: { ownerUserId: repA.id } })) === 0);

    // ───────────────────────────────────────────────────────────────────────────
    section("Limits");

    requests.length = 0;
    script = () => ({ toolCalls: [{ id: "loop", name: "my_tasks", input: {} }] });
    const looping = await chat(repA.id, "Keep going");
    ok(`a model that never stops calling tools is stopped after ${agent.MAX_STEPS} turns`, requests.length === agent.MAX_STEPS && !looping.error, requests.length);

    requests.length = 0;
    script = () => ({ text: "", stop: "refused" });
    const declined = await chat(repA.id, "Something odd");
    ok("a refusal is said plainly and recorded", declined.events.some((e) => e.type === "text" && e.delta.includes("declined")));

    config.dailyTokenLimit = 1_000;
    const spent = await chat(repA.id, "One more");
    ok("the daily allowance, once used, stops the next question before anything is spent", spent.error.includes("allowance") && requests.length === 1, spent.error);
    config.dailyTokenLimit = 100_000;

    ok("somebody without the permission is refused", (await chat(noCop.id, "Hi")).error.includes("access"));
    config.hasKey.ANTHROPIC = false;
    delete keys.ANTHROPIC;
    ok("with no key, it says who can add one", (await chat(repB.id, "Hi")).error.includes("API key"));
    config.hasKey.ANTHROPIC = true;
    keys.ANTHROPIC = "sk-ant-zzcop-not-a-key";
    config.enabled = false;
    ok("switched off, it is off", (await chat(repB.id, "Hi")).error.includes("switched off"));
    actorId = repB.id;
    ok("  and the header has no button", (await actions.getCopilotAvailability()) === null);
    config.enabled = true;
    ok("  switched on, it has", (await actions.getCopilotAvailability())?.available === true);

    // ───────────────────────────────────────────────────────────────────────────
    section("Settings");

    // These are about the real row, so they write it — and put it back straight after.
    settingsLib.setTestSettings(null);
    const anthropicBefore = (await db.copilotSettings.findUnique({ where: { id: "global" } }))?.anthropicKeyCipher ?? null;
    actorId = repA.id;
    ok("only somebody who can change settings sees or saves them", (await actions.getCopilotSettings()) === null && !(await actions.saveCopilotSettings({ enabled: true, provider: "OPENAI", model: "x", dailyTokenLimit: 5000 })).ok);
    actorId = admin.id;
    const saveRes = await actions.saveCopilotSettings({ enabled: true, provider: "OPENAI", model: "gpt-zz", dailyTokenLimit: 200_000, keys: { OPENAI: "sk-zzcop-openai-secret-123" } });
    const row = await db.copilotSettings.findUnique({ where: { id: "global" } });
    ok("a key is stored encrypted", saveRes.ok && !!row?.openaiKeyCipher && !row.openaiKeyCipher.includes("sk-zzcop") && decryptSecret(row.openaiKeyCipher) === "sk-zzcop-openai-secret-123");
    const view = await actions.getCopilotSettings();
    ok("  and never read back — the screen is told only that there is one", !!view && !JSON.stringify(view).includes("sk-zzcop") && view.hasKey.OPENAI);
    ok("  the other providers keep their keys", (row?.anthropicKeyCipher ?? null) === anthropicBefore);
    ok("switching on a provider with no key is refused", !(await actions.saveCopilotSettings({ enabled: true, provider: "GEMINI", model: "g", dailyTokenLimit: 5000 })).ok);
    ok("so is a model name that isn't one, and a limit out of range", !(await actions.saveCopilotSettings({ enabled: false, provider: "ANTHROPIC", model: "rm -rf /", dailyTokenLimit: 5000 })).ok && !(await actions.saveCopilotSettings({ enabled: false, provider: "ANTHROPIC", model: "m", dailyTokenLimit: 10 })).ok);
    const models = await actions.listCopilotModels("OPENAI");
    ok("the model list comes from the provider, sorted", models.ok && models.data.join() === "fake-a,fake-b");
    ok("the change is audited, without the key", (await db.auditLog.count({ where: { userId: admin.id, entityType: "CopilotSettings", entityLabel: { contains: "key replaced" } } })) === 1 && (await db.auditLog.count({ where: { userId: admin.id, entityLabel: { contains: "sk-zzcop" } } })) === 0);
    const usage = view?.usage.find((u) => u.name === "Zzcop RepA");
    ok("usage per person is on the settings screen", !!usage && usage.today > 0 && usage.requests > 0);

    const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
    const Page = (require("../src/app/(dashboard)/settings/copilot/page") as { default: () => Promise<ReactElement> }).default;
    const html = renderToStaticMarkup(await Page());
    ok("the settings page renders, keys shown only as saved", html.includes("AI copilot") && html.includes("key saved") && !html.includes("sk-zzcop"));
    await restore();

    // ───────────────────────────────────────────────────────────────────────────
    section("The chat endpoint");

    settingsLib.setTestSettings({ config, keys });
    const { POST } = require("../src/app/api/copilot/chat/route") as typeof import("../src/app/api/copilot/chat/route");
    const post = (headers: Record<string, string>, body: unknown) =>
      POST(new Request("http://localhost:3000/api/copilot/chat", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
    actorId = repA.id;
    ok("a post from another site is refused", (await post({ origin: "https://evil.example", host: "localhost:3000" }, { message: "hi" })).status === 403);
    viewingAs = true;
    ok("  so is one while viewing as somebody", (await post({ origin: "http://localhost:3000", host: "localhost:3000" }, { message: "hi" })).status === 403);
    viewingAs = false;
    actorId = "";
    ok("  and one from nobody signed in", (await post({ origin: "http://localhost:3000", host: "localhost:3000" }, { message: "hi" })).status === 401);
    actorId = repA.id;
    script = () => ({ text: "Streaming works." });
    const res = await post({ origin: "http://localhost:3000", host: "localhost:3000" }, { message: "hi" });
    const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l) as ChatEvent);
    ok("from the app, it streams one event per line", res.headers.get("content-type")?.includes("ndjson") === true && lines[0]?.type === "conversation" && lines.at(-1)?.type === "done" && lines.some((l) => l.type === "text"));
  } finally {
    providers.setTestProvider(null);
    settingsLib.setTestSettings(null);
    await restore();
    await cleanup();
  }

  console.log(failures === 0 ? "\nAll copilot checks passed." : `\n${failures} check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
