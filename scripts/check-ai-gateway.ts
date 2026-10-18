/**
 * check:ai-gateway — Deskzo AI's gateway (owner, 17 Oct 2026; src/lib/ai/accounts.ts, gateway.ts and the
 * adapters in src/lib/copilot/providers), and console › Settings › AI.
 *
 * On a scratch control plane (dropped at the end, pass or fail). No provider is ever reached: the
 * adapter is a stand-in that records what it was asked, `fetch` throws, and mail is caught.
 *
 *   · the catalogue: every feature and kind of account once; Bedrock's India profiles, priced above cost;
 *   · accounts: what is refused; a key sealed under the platform key, never read back, kept when left
 *     blank; a kind that never changes; the suggested models, once;
 *   · models and routing: keys that never change, rates in range, a feature only on a model that is on,
 *     and nothing it runs on switched off or removed;
 *   · what each provider is sent: Claude on Bedrock without what Bedrock refuses, with its cache marks;
 *     Claude's own API with fallbacks; Azure, a compatible server, Vertex;
 *   · a turn: the route's model and opened key reach the adapter, the turn is charged to the person under
 *     the model's key; a provider's failure charges nothing and says nothing of the key; the kill switch;
 *   · testing an account: the result kept, the key never in it;
 *   · the console: owners change it; a seller adds credits, with a reason; the pages show it, no secret.
 *
 *   npm run check:ai-gateway
 */
import "dotenv/config";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import Module from "node:module";
import path from "node:path";
import { directClient } from "../src/lib/tenancy/direct-client";
import { renderHtml } from "./lib/render-html";

process.env.DESKZO_TENANCY_FALLBACK = "legacy";
process.env.TRUST_PROXY = "";
process.env.PLATFORM_CONSOLE_IP_ALLOWLIST = "";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${String(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}
async function thrown(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return "";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// Nothing here calls out.
const outside: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  outside.push(url);
  throw new Error(`check:ai-gateway makes no outside calls — ${url}`);
}) as typeof fetch;

// ─── A request, as the console sees one ────────────────────────────────────────────────────────
const jar = new Map<string, string>();
const requestHeaders = new Headers({ host: "admin.localhost:3000", "user-agent": "check:ai-gateway" });
const internals = Module as unknown as { _load(request: string, parent: { filename?: string } | undefined, isMain: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: { filename?: string } | undefined, isMain: boolean) {
  if (request === "next/headers" || request.endsWith(`${path.sep}next${path.sep}headers.js`)) {
    return {
      headers: async () => requestHeaders,
      cookies: async () => ({
        get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
        getAll: () => [...jar].map(([name, value]) => ({ name, value })),
        has: (name: string) => jar.has(name),
        set: (name: string, value: string) => void jar.set(name, value),
        delete: (name: string) => void jar.delete(name),
      }),
    };
  }
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/notify") return { notifyUser: async () => null };
  if (request === "next/navigation") {
    return {
      redirect: (to: string) => {
        throw new Error(`redirect ${to}`);
      },
      notFound: () => {
        throw new Error("notFound");
      },
      useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, prefetch() {} }),
      usePathname: () => "/",
      useSearchParams: () => new URLSearchParams(),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

type Page = () => Promise<unknown>;
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url || !process.env.PLATFORM_MASTER_KEY) throw new Error("DATABASE_URL and PLATFORM_MASTER_KEY are needed.");
  const realName = new URL(url).pathname.slice(1);
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(new URL(url).hostname);

  section("A scratch control plane");
  ok("the database server is a local one", local);
  if (!local) throw new Error("not a local database");
  const controlName = `${realName}_aigateway_control`;
  const controlUrl = withDatabase(url, controlName);
  const admin = directClient(withDatabase(url, "postgres"));
  let cleanup: (() => Promise<void>) | null = null;
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${controlName}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${controlName}"`);
    execSync("npx prisma migrate deploy --config prisma.control.config.ts", { stdio: "pipe", env: { ...process.env, CONTROL_DATABASE_URL: controlUrl }, timeout: 5 * 60_000 });
    process.env.CONTROL_DATABASE_URL = controlUrl;
    ok("built from its migrations", true);

    /* eslint-disable @typescript-eslint/no-require-imports */
    const { controlDb, closeControlDb } = require("../src/lib/platform/control-db") as typeof import("../src/lib/platform/control-db");
    const mailer = require("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer");
    const kek = require("../src/lib/platform/kek") as typeof import("../src/lib/platform/kek");
    const plans = require("../src/lib/platform/plans") as typeof import("../src/lib/platform/plans");
    const rules = require("../src/lib/entitlements") as typeof import("../src/lib/entitlements");
    const keys = require("../src/lib/tenancy/keys") as typeof import("../src/lib/tenancy/keys");
    const registry = require("../src/lib/tenancy/registry") as typeof import("../src/lib/tenancy/registry");
    const { runAsTenant } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
    const staffLib = require("../src/lib/platform/staff") as typeof import("../src/lib/platform/staff");
    const catalogue = require("../src/lib/ai/catalogue") as typeof import("../src/lib/ai/catalogue");
    const accounts = require("../src/lib/ai/accounts") as typeof import("../src/lib/ai/accounts");
    const aiSettings = require("../src/lib/ai/settings") as typeof import("../src/lib/ai/settings");
    const gateway = require("../src/lib/ai/gateway") as typeof import("../src/lib/ai/gateway");
    const providers = require("../src/lib/copilot/providers") as typeof import("../src/lib/copilot/providers");
    const anthropicAdapter = require("../src/lib/copilot/providers/anthropic") as typeof import("../src/lib/copilot/providers/anthropic");
    const openaiAdapter = require("../src/lib/copilot/providers/openai") as typeof import("../src/lib/copilot/providers/openai");
    const geminiAdapter = require("../src/lib/copilot/providers/gemini") as typeof import("../src/lib/copilot/providers/gemini");
    const copilotSettings = require("../src/lib/copilot/settings") as typeof import("../src/lib/copilot/settings");
    const consoleAi = require("../src/actions/platform/console-ai") as typeof import("../src/actions/platform/console-ai");
    const { AzureOpenAI } = require("openai") as typeof import("openai");
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    /* eslint-enable @typescript-eslint/no-require-imports */
    type Tenant = import("../src/lib/tenancy/state").Tenant;
    type TurnRequest = import("../src/lib/copilot/types").TurnRequest;
    cleanup = async () => {
      await db.$disconnect();
      await closeControlDb();
    };
    const control = controlDb();
    mailer.setTestPlatformMailer(async () => {});
    copilotSettings.setTestSettings({ enabled: true, draftingEnabled: true, dailyCreditLimit: null });

    // The stand-in provider: every request kept, an answer or a failure from a script. Nothing leaves.
    const requests: TurnRequest[] = [];
    let answer: (req: TurnRequest) => Error | { text: string } = () => ({ text: "OK" });
    providers.setTestProvider({
      async runTurn(req) {
        requests.push(req);
        const a = answer(req);
        if (a instanceof Error) throw a;
        req.onText(a.text);
        return { text: a.text, toolCalls: [], native: null, usage: { input: 2_000, output: 100 }, stop: "done", model: req.model };
      },
    });

    section("The catalogue");
    ok("every feature once, and recognised", new Set(catalogue.AI_FEATURES.map((f) => f.key)).size === catalogue.AI_FEATURES.length && catalogue.AI_FEATURES.every((f) => catalogue.isAiFeature(f.key)) && !catalogue.isAiFeature("copilot.anything"));
    ok("every kind of account listed once, each with a name and the API it speaks", new Set(catalogue.PROVIDER_KIND_ORDER).size === Object.keys(catalogue.PROVIDER_KINDS).length && catalogue.PROVIDER_KIND_ORDER.every((k) => !!catalogue.PROVIDER_KINDS[k].label && ["ANTHROPIC", "OPENAI", "GEMINI"].includes(catalogue.familyOf(k))));
    const bedrock = catalogue.PROVIDER_KINDS.BEDROCK.suggested;
    ok("Bedrock's suggested models are India's profiles, from Mumbai", bedrock.region === "ap-south-1" && bedrock.models.length === 3 && bedrock.models.every((m) => m.providerModel.startsWith("in.anthropic.")));
    ok("  each priced above what it costs Deskzo (a credit is ₹1, 100 paise)", bedrock.models.every((m) => m.inputRate * 100 > m.inputCost && m.outputRate * 100 > m.outputCost));

    section("Accounts");
    const SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYzzgatewaykey";
    const goodBedrock = { name: "Bedrock India", kind: "BEDROCK", region: "ap-south-1", keyId: "AKIAZZGATEWAY0000001", secret: SECRET, residency: "India (Mumbai and Hyderabad)", noTraining: true, active: true };
    const refusals = {
      noKind: await thrown(() => accounts.saveAccount({ ...goodBedrock, kind: "ZZ" }, "script:check")),
      region: await thrown(() => accounts.saveAccount({ ...goodBedrock, region: "mumbai" }, "script:check")),
      keyId: await thrown(() => accounts.saveAccount({ ...goodBedrock, keyId: "not-a-key-id" }, "script:check")),
      noSecret: await thrown(() => accounts.saveAccount({ ...goodBedrock, secret: "" }, "script:check")),
      spaced: await thrown(() => accounts.saveAccount({ ...goodBedrock, secret: "has a space in it" }, "script:check")),
      residency: await thrown(() => accounts.saveAccount({ ...goodBedrock, residency: "" }, "script:check")),
      global: await thrown(() => accounts.saveAccount({ name: "Vertex", kind: "VERTEX", region: "global", keyId: "zz-project", secret: "{}", residency: "India", noTraining: false, active: true }, "script:check")),
      notJson: await thrown(() => accounts.saveAccount({ name: "Vertex", kind: "VERTEX", region: "asia-south1", keyId: "zz-project", secret: "AIzaNotJsonAtAll", residency: "India", noTraining: false, active: true }, "script:check")),
      plainHttp: await thrown(() => accounts.saveAccount({ name: "Mine", kind: "OPENAI_COMPATIBLE", endpoint: "http://ai.example.com/v1", residency: "Ours", noTraining: true, active: true }, "script:check")),
      userInUrl: await thrown(() => accounts.saveAccount({ name: "Mine", kind: "OPENAI_COMPATIBLE", endpoint: "https://me:pw@ai.example.com/v1", residency: "Ours", noTraining: true, active: true }, "script:check")),
    };
    ok("refused: no kind, a region that isn't AWS's, an access key id that isn't one, no key, a key with spaces, no residency", Object.values(refusals).slice(0, 6).every((r) => r !== ""), JSON.stringify(refusals).slice(0, 300));
    ok("  Vertex's 'global', which sends requests anywhere, and a key that isn't a service account's JSON", /never global/.test(refusals.global) && /JSON/.test(refusals.notJson));
    ok("  a server reached by plain http on the open internet, or with a password in its address", /https/.test(refusals.plainHttp) && /user name or password/.test(refusals.userInUrl));
    const own = await accounts.saveAccount({ name: "Private GPU", kind: "OPENAI_COMPATIBLE", endpoint: "http://10.0.0.5:8000/v1", residency: "Deskzo's own servers", noTraining: true, active: true }, "script:check");
    ok("a compatible server on the private network, over http and with no key, is accepted", own.created);
    const made = await accounts.saveAccount(goodBedrock, "script:check");
    const row = await control.aiAccount.findUniqueOrThrow({ where: { id: made.id } });
    ok("a Bedrock account: the key sealed under the platform key, not kept in the clear", made.created && !!row.secretCipher && !row.secretCipher.includes(SECRET) && kek.openForPlatform("ai-account", row.secretCipher) === SECRET);
    const setupJson = JSON.stringify(await accounts.aiSetup());
    ok("  never read back: the console's view says only that one is saved", !setupJson.includes(SECRET) && !setupJson.includes(row.secretCipher ?? SECRET) && setupJson.includes('"hasSecret":true'));
    const edited = await accounts.saveAccount({ ...goodBedrock, id: made.id, name: "Bedrock Mumbai", secret: "" }, "script:check");
    const rowAfter = await control.aiAccount.findUniqueOrThrow({ where: { id: made.id } });
    ok("  changed with the key left blank: the saved key stays, the change says what changed", rowAfter.secretCipher === row.secretCipher && rowAfter.name === "Bedrock Mumbai" && edited.changed.join() === "name", edited.changed.join());
    ok("  and its kind never changes", /kind can't change/.test(await thrown(() => accounts.saveAccount({ ...goodBedrock, id: made.id, kind: "ANTHROPIC" }, "script:check"))));
    const suggested = await accounts.addSuggestedModels(made.id, "script:check");
    ok("its suggested models are added once", suggested.length === 3 && (await accounts.addSuggestedModels(made.id, "script:check")).length === 0, suggested.join());

    section("Models and routing");
    const sonnet = await control.aiModel.findUniqueOrThrow({ where: { key: "claude-sonnet-5-india" } });
    const haiku = await control.aiModel.findUniqueOrThrow({ where: { key: "claude-haiku-4-5-india" } });
    const modelBase = { accountId: made.id, key: "zz-model", label: "Zz", providerModel: "zz-model-1", inputRate: 100, outputRate: 500, active: true };
    const modelRefusals = [
      await thrown(() => accounts.saveModel({ ...modelBase, key: "Has Spaces" }, "script:check")),
      await thrown(() => accounts.saveModel({ ...modelBase, key: "claude-sonnet-5-india" }, "script:check")),
      await thrown(() => accounts.saveModel({ ...modelBase, inputRate: -1 }, "script:check")),
      await thrown(() => accounts.saveModel({ ...modelBase, providerModel: "rm -rf /" }, "script:check")),
      await thrown(() => accounts.saveModel({ ...modelBase, accountId: "nope" }, "script:check")),
    ];
    ok("refused: a key that isn't one, a key already taken, a negative rate, a provider name that isn't one, no account", modelRefusals.every((r) => r !== ""), modelRefusals.join(" | "));
    const zz = await accounts.saveModel({ ...modelBase, active: false }, "script:check");
    await accounts.saveModel({ ...modelBase, id: zz.id, key: "renamed", label: "Zz renamed", active: false }, "script:check");
    ok("a model's key never changes — it is kept on every charge", (await control.aiModel.findUniqueOrThrow({ where: { id: zz.id } })).key === "zz-model");
    ok("a feature can't run on a model that is off", /switched on/.test(await thrown(() => accounts.saveRoutes({ "copilot.chat": zz.id }, "script:check"))));
    const changed = await accounts.saveRoutes({ "copilot.chat": sonnet.id, "automate.draft": haiku.id }, "script:check");
    ok("each feature is routed to a model", changed.join() === "copilot.chat,automate.draft" && (await accounts.saveRoutes({ "copilot.chat": sonnet.id }, "script:check")).length === 0);
    ok("a model a feature runs on can't be switched off, or removed", /Move it to another model/.test(await thrown(() => accounts.saveModel({ ...modelBase, id: sonnet.id, key: sonnet.key, label: sonnet.label, providerModel: sonnet.providerModel, active: false }, "script:check"))) && /Move it/.test(await thrown(() => accounts.removeModel(sonnet.id))));
    ok("  nor the account it is on", /Move it to another model first/.test(await thrown(() => accounts.removeAccount(made.id))));
    const route = await accounts.routeFor("copilot.chat");
    const conn = route?.connection();
    ok("the route: the model, its rates, the account, and a connection with the key opened only now", route?.model.key === "claude-sonnet-5-india" && route.account.kind === "BEDROCK" && conn?.kind === "BEDROCK" && conn.region === "ap-south-1" && conn.accessKeyId === "AKIAZZGATEWAY0000001" && conn.secret === SECRET);
    ok("a key the platform key can't open is said plainly, for staff", /can't be opened/.test(await thrown(async () => accounts.connectionFor({ ...row, secretCipher: "not-a-sealed-value" }))));
    const sa = JSON.stringify({ type: "service_account", client_email: "zz@zz-project.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----\nzz\n-----END PRIVATE KEY-----\n" });
    const vertexConn = accounts.connectionFor({ name: "V", kind: "VERTEX", region: "asia-south1", endpoint: null, keyId: "zz-project", secretCipher: kek.sealForPlatform("ai-account", sa) });
    ok("a Vertex connection: its project, its location and the service account", vertexConn.kind === "VERTEX" && vertexConn.location === "asia-south1" && vertexConn.project === "zz-project" && vertexConn.credentials.client_email === "zz@zz-project.iam.gserviceaccount.com");

    section("What each provider is sent");
    const history = [{ role: "user" as const, text: "Find Acme" }];
    const tools = [{ name: "search", description: "Search", parameters: { type: "object", properties: {} } }];
    const base = { model: "in.anthropic.claude-sonnet-5", system: "SYS", history, tools, onText: () => {} };
    const onBedrock = anthropicAdapter.claudeParams({ ...base, connection: conn! }, true) as unknown as Record<string, unknown>;
    ok("Claude on Bedrock: no eager tool streaming, no request-wide cache mark, no server-side fallback", !JSON.stringify(onBedrock.tools).includes("eager_input_streaming") && !("cache_control" in onBedrock) && !("fallbacks" in onBedrock) && !("betas" in onBedrock));
    const sys = onBedrock.system as { cache_control?: unknown }[];
    const lastMessage = (onBedrock.messages as { content: { cache_control?: unknown }[] }[]).at(-1)!;
    ok("  the cache marked on the system prompt and the newest message instead", Array.isArray(sys) && !!sys[0]?.cache_control && Array.isArray(lastMessage.content) && !!lastMessage.content.at(-1)?.cache_control);
    const direct = anthropicAdapter.claudeParams({ ...base, model: "claude-opus-5", connection: { kind: "ANTHROPIC", apiKey: "sk-ant-zz" } }, false) as unknown as Record<string, unknown>;
    ok("Claude's own API: tools streamed as written, the request cached, Opus 5's refusals retried server-side", JSON.stringify(direct.tools).includes("eager_input_streaming") && "cache_control" in direct && direct.fallbacks === "default");
    ok("  a test asks for a few tokens only", (anthropicAdapter.claudeParams({ ...base, maxTokens: 64, connection: conn! }, true) as { max_tokens: number }).max_tokens === 64);
    ok("an account that doesn't speak Claude's API is never sent Claude's request", /doesn't speak Claude's API/.test(await thrown(async () => anthropicAdapter.claudeClient({ kind: "OPENAI", apiKey: "x" }))));
    ok("Azure: the Azure client, the model being the deployment", openaiAdapter.openaiClient({ kind: "AZURE_OPENAI", endpoint: "https://zz.openai.azure.com", apiVersion: "2024-10-21", apiKey: "zz" }) instanceof AzureOpenAI);
    ok("a compatible server: OpenAI's client at its own address", openaiAdapter.openaiClient({ kind: "OPENAI_COMPATIBLE", baseURL: "http://10.0.0.5:8000/v1", apiKey: null }).baseURL === "http://10.0.0.5:8000/v1");
    ok("Vertex: Gemini's client made as the service account, without a call", !!geminiAdapter.geminiClient(vertexConn));

    section("A turn through the gateway");
    await plans.savePlan({ countries: [], seats: null, copilotTokens: 100, modules: ["tasks"], kind: "EDITION", key: "zz-ai", name: "Zz AI", isDefault: true }, "script:check");
    const tenantId = randomUUID();
    await control.tenant.create({ data: { id: tenantId, slug: "zzaigw-a", name: "Zz gateway", status: "ACTIVE", keyBundleCipher: keys.sealKeyBundle(tenantId, keys.newKeyBundle()), country: "IN", currency: "INR", ownerEmail: "owner@zzaigw.example" } });
    await plans.setWorkspacePlans(tenantId, [{ planKey: "zz-ai", quantity: 1 }], "script:check");
    const envTenant = await registry.legacyTenant();
    if (!envTenant) throw new Error("No local workspace to stand the scratch one on.");
    const standIn = async (): Promise<Tenant> => {
      const t = await control.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { entitlements: true } });
      return { ...envTenant, id: tenantId, slug: "zzaigw-a", name: "Zz gateway", entitlements: rules.parseEntitlements(t.entitlements), source: "control", isDefault: false, timezone: "Asia/Kolkata" };
    };
    const inWs = async <T,>(work: () => Promise<T>) => runAsTenant(await standIn(), work);
    requests.length = 0;
    answer = () => ({ text: "Here it is." });
    const outcome = await inWs(() => gateway.aiTurn({ userId: "zz-user", feature: "copilot.chat", system: "SYS", history, tools }));
    const sentTo = requests[0]!;
    ok("the adapter is given the route's model and the account's opened key", sentTo.model === "in.anthropic.claude-sonnet-5" && sentTo.connection.kind === "BEDROCK" && (sentTo.connection as { secret: string }).secret === SECRET);
    ok("  the answer comes back with the API it spoke and the model's key", outcome.text === "Here it is." && outcome.family === "ANTHROPIC" && outcome.modelKey === "claude-sonnet-5-india");
    const usage = await control.aiUsage.findMany({ where: { tenantId } });
    ok("  charged to the person under the model's key: 2,000 in and 100 out at 270 and 1,350 is 0.675 credits", usage.length === 1 && usage[0]!.userId === "zz-user" && usage[0]!.modelKey === "claude-sonnet-5-india" && usage[0]!.credits === 675 && outcome.charge.credits === 675, usage[0]?.credits);
    const drafting = await inWs(() => gateway.aiTurn({ userId: "zz-user", feature: "automate.draft", system: "SYS", history, tools: [] }));
    ok("each feature on its own model: drafting on Haiku", drafting.modelKey === "claude-haiku-4-5-india" && requests.at(-1)!.model === "in.anthropic.claude-haiku-4-5-20251001-v1:0");
    answer = () => Object.assign(new Error(`Too many requests for key ${SECRET} (sk-ant-api03-zzzzzzzzzzzzzzzzzzzz)`), { status: 429 });
    const logged: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
    const busy = await thrown(() => inWs(() => gateway.aiTurn({ userId: "zz-user", feature: "copilot.chat", system: "SYS", history, tools })));
    console.error = realError;
    ok("a provider's failure: the person is told it's busy, in Deskzo's words", busy === "Deskzo AI is busy just now. Try again in a minute.", busy);
    ok("  nothing is charged for it", (await control.aiUsage.count({ where: { tenantId } })) === 2);
    ok("  and the server's log carries neither the account's key nor a key-shaped string", logged.length === 1 && !logged[0]!.includes(SECRET) && !logged[0]!.includes("zzzzzzzzzzzzzzzzzzzz"), logged[0]);
    answer = () => ({ text: "OK" });
    await control.aiAccount.update({ where: { id: made.id }, data: { active: false } });
    ok("the account switched off: the feature isn't set up, and it says Deskzo AI isn't available", (await accounts.routeFor("copilot.chat")) === null && /isn't available/.test((await inWs(() => gateway.aiUnavailable("zz-user", "copilot.chat"))) ?? ""));
    await control.aiAccount.update({ where: { id: made.id }, data: { active: true } });
    const service = await gateway.aiService("copilot.chat");
    ok("where requests go, in words: the model, where it is processed, and that it isn't used for training", service?.model === "Claude Sonnet 5" && service.residency === "India (Mumbai and Hyderabad)" && service.noTraining === true);

    section("Testing an account");
    requests.length = 0;
    const tested = await accounts.testAccount(made.id);
    ok("a test asks the first model for one word, with a few tokens", tested.ok && requests.length === 1 && requests[0]!.maxTokens === 64 && requests[0]!.tools.length === 0);
    ok("  the result is kept on the account", (await control.aiAccount.findUniqueOrThrow({ where: { id: made.id } })).lastTestOk === true);
    answer = () => new Error(`The security token included in the request is invalid: ${SECRET} AKIAZZGATEWAY0000001`);
    const failed = await accounts.testAccount(made.id);
    const kept = (await control.aiAccount.findUniqueOrThrow({ where: { id: made.id } })).lastTestError ?? "";
    ok("a failed test keeps the provider's reason — without the key or the key id", !failed.ok && kept.includes("security token") && !kept.includes(SECRET) && !kept.includes("AKIAZZGATEWAY0000001"), kept);
    answer = () => ({ text: "OK" });

    section("The console");
    const owner = (await staffLib.createStaff({ email: "owner@zzaigw.example", name: "Zz Owner", role: "OWNER" }, "script:check")).id;
    const adminStaff = (await staffLib.createStaff({ email: "admin@zzaigw.example", name: "Zz Admin", role: "ADMIN" }, "script:check")).id;
    const billing = (await staffLib.createStaff({ email: "billing@zzaigw.example", name: "Zz Billing", role: "BILLING" }, "script:check")).id;
    const support = (await staffLib.createStaff({ email: "support@zzaigw.example", name: "Zz Support", role: "SUPPORT" }, "script:check")).id;
    const actAs = async (userId: string) => {
      const token = randomBytes(32).toString("base64url");
      await control.platformSession.create({ data: { id: sha256(token), userId, expiresAt: new Date(Date.now() + 3_600_000), mfaAt: new Date() } });
      jar.set("deskzo-console", token);
    };
    await actAs(adminStaff);
    ok("an admin can't change where AI runs, or pause it", !(await consoleAi.consoleSaveAiAccount({ ...goodBedrock, name: "By admin" })).ok && !(await consoleAi.consoleSetAiPaused(true)).ok);
    await actAs(owner);
    const byOwner = await consoleAi.consoleSaveAiAccount({ name: "Anthropic US", kind: "ANTHROPIC", secret: "sk-ant-api03-zzownerzzownerzzowner", residency: "United States", noTraining: true, active: true });
    ok("an owner adds an account; the audit names it, never its key", byOwner.ok && (await control.platformAuditLog.count({ where: { action: "ai.account.add", actor: owner } })) === 1 && !JSON.stringify(await control.platformAuditLog.findMany({ where: { actor: owner } })).includes("zzowner"));
    const paused = await consoleAi.consoleSetAiPaused(true);
    ok("an owner pauses AI everywhere, and nothing runs", paused.ok && (await aiSettings.aiPaused()) && /paused/.test((await inWs(() => gateway.aiUnavailable("zz-user", "copilot.chat"))) ?? ""));
    await consoleAi.consoleSetAiPaused(false);
    ok("  and resumes it", !(await aiSettings.aiPaused()) && (await inWs(() => gateway.aiUnavailable("zz-user", "copilot.chat"))) === null);
    ok("packs that aren't a list of one to six are refused", !(await consoleAi.consoleSaveAiPacks([])).ok && !(await consoleAi.consoleSaveAiPacks([{ credits: 500, inr: 49_900 }, { credits: 500, inr: 1 }])).ok);
    ok("  a list that is one is saved, smallest first", (await consoleAi.consoleSaveAiPacks([{ credits: 5_000, inr: 400_000 }, { credits: 100, inr: 10_000 }])).ok && (await aiSettings.aiPacks()).map((p) => p.key).join() === "ai-100,ai-5000");
    await actAs(support);
    ok("support can't add credits to a workspace", !(await consoleAi.consoleGrantAiCredits({ tenantId, credits: 50, reason: "zz goodwill" })).ok);
    await actAs(billing);
    ok("a seller adds credits only with a reason", !(await consoleAi.consoleGrantAiCredits({ tenantId, credits: 50, reason: "" })).ok);
    const given = await consoleAi.consoleGrantAiCredits({ tenantId, credits: 50, reason: "zz goodwill" });
    const paid = await consoleAi.consoleGrantAiCredits({ tenantId, credits: 500, reason: "zz NEFT UTR-1", paid: true });
    const grants = await control.aiCreditPack.findMany({ where: { tenantId }, orderBy: { createdAt: "asc" } });
    ok("  given, or paid by bank transfer: kept with who, why and how", given.ok && paid.ok && grants.length === 2 && grants[0]!.source === "STAFF" && grants[1]!.source === "OFFLINE" && grants[1]!.grantedBy === billing && grants[1]!.reason === "zz NEFT UTR-1");
    ok("  in the audit log, against the workspace", (await control.platformAuditLog.count({ where: { action: "ai.credits.grant", tenantId } })) === 2);
    await actAs(owner);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const AiPage = (require("../src/app/platform-console/(console)/settings/ai/page") as { default: Page }).default;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const SettingsPage = (require("../src/app/platform-console/(console)/settings/page") as { default: Page }).default;
    const asOwner = await renderHtml(AiPage() as never);
    ok("Settings › AI, for an owner: the accounts, their models and routing, with the controls — and no key", text(asOwner).includes("Bedrock Mumbai") && text(asOwner).includes("Claude Sonnet 5") && asOwner.includes("Add account") && !asOwner.includes(SECRET) && !asOwner.includes("zzowner"));
    await actAs(billing);
    const asBilling = text(await renderHtml(AiPage() as never));
    ok("  for billing staff: the same, in words, view only", asBilling.includes("View only") && asBilling.includes("Bedrock Mumbai") && !asBilling.includes("Add account"));
    const index = text(await renderHtml(SettingsPage() as never));
    ok("all settings: a Deskzo AI section, saying what each feature runs on", index.includes("Deskzo AI") && index.includes("Copilot chat: Claude Sonnet 5") && index.includes("Automate: drafting a workflow: Claude Haiku 4.5"));

    section("New code on a control plane its migration hasn't reached yet");
    // As between a deploy and `tenants:migrate`: the AI tables aren't there.
    await control.$executeRawUnsafe(`DROP TABLE "ai_routes", "ai_usage", "ai_credit_months", "ai_credit_packs" CASCADE`);
    const credits = require("../src/lib/ai/credits") as typeof import("../src/lib/ai/credits"); // eslint-disable-line @typescript-eslint/no-require-imports
    ok("no feature counts as set up — not an error", (await accounts.routeFor("copilot.chat")) === null);
    const before = await inWs(() => gateway.aiUnavailable("zz-user", "copilot.chat"));
    ok("  a person is told Deskzo AI isn't available, and nothing runs", /isn't available/.test(before ?? ""), before);
    const standing = await credits.creditStanding(await standIn());
    ok("  the credits read as no ledger yet, and today's use as none", !standing.metered && (await credits.usedTodayBy("zz-user", await standIn())) === 0);
    await actAs(owner);
    const notReady = text(await renderHtml(AiPage() as never));
    ok("  Settings › AI says the migrations haven't run, rather than failing", notReady.includes("Not ready yet"));
  } finally {
    try {
      const req = Module.createRequire(__filename);
      (req("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer")).setTestPlatformMailer(null);
      (req("../src/lib/copilot/providers") as typeof import("../src/lib/copilot/providers")).setTestProvider(null);
      (req("../src/lib/copilot/settings") as typeof import("../src/lib/copilot/settings")).setTestSettings(null);
    } catch {
      // Never loaded.
    }
    if (cleanup) await cleanup().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${controlName}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRaw<{ n: bigint }[]>`select count(*)::bigint as n from pg_database where datname = ${controlName}`;
    ok("the scratch control plane is dropped", Number(left[0]!.n) === 0);
    ok("and not one request left the machine", outside.length === 0, outside.join(", "));
    await admin.$disconnect();
  }

  console.log(failures === 0 ? `\nAll ${passes} AI gateway checks passed.` : `\n${failures} check(s) FAILED (${passes} passed).`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
