import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ButtonLink, Container, Eyebrow } from "@/components/site/ui";
import { API_INTRO, API_OPERATIONS, EXAMPLES, bodySchema, listRowExample, type ApiOperation } from "@/lib/api/openapi";
import { API_DEFAULT_PAGE_SIZE, API_SCOPES } from "@/lib/api/scopes";

/**
 * deskzo.com/developers — the public API's documentation (owner, 17 Oct 2026), drawn from the one
 * description of it (src/lib/api/openapi.ts): every endpoint, the scope it needs, what it takes — the
 * very schemas the endpoints check — and an example of what it answers. Nothing here is typed twice.
 */

export const metadata: Metadata = {
  title: "Deskzo API — developer documentation",
  description: API_INTRO.summary,
};

const BASE = "https://your-workspace.deskzo.com/api/v1";

/** `code` in a sentence, as code. */
function prose(text: string): ReactNode[] {
  return text.split(/(`[^`]+`)/g).map((part, i) =>
    part.startsWith("`") && part.endsWith("`") ? (
      <code key={i} className="rounded bg-surface-sunken px-1 py-0.5 font-mono text-[0.85em] text-text">
        {part.slice(1, -1)}
      </code>
    ) : (
      part
    ),
  );
}

type FieldRow = { name: string; type: string; required: boolean; about: string };

/** A request body's fields, from its JSON Schema — nested objects flattened as `address.city`. */
function fieldRows(schema: Record<string, unknown>, prefix = ""): FieldRow[] {
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set((schema.required as string[] | undefined) ?? []);
  const rows: FieldRow[] = [];
  for (const [name, prop] of Object.entries(properties)) {
    const variants = (prop.anyOf as Record<string, unknown>[] | undefined) ?? [prop];
    const main = variants.find((v) => v.type !== "null") ?? prop;
    const values = (main.enum as string[] | undefined) ?? null;
    const type = values ? `one of ${values.join(", ")}` : main.type === "array" ? `list of ${((main.items as Record<string, unknown> | undefined)?.type as string | undefined) ?? "objects"}` : String(main.type ?? "any");
    const limits = [main.minLength ? `at least ${main.minLength}` : null, main.maxLength ? `at most ${main.maxLength} characters` : null, main.pattern ? "yyyy-mm-dd" : null].filter(Boolean).join(", ");
    rows.push({ name: `${prefix}${name}`, type, required: required.has(name), about: [prop.description ?? main.description, limits].filter(Boolean).join(" — ") });
    if (main.type === "object" && main.properties) rows.push(...fieldRows(main, `${prefix}${name}.`));
    if (main.type === "array" && (main.items as Record<string, unknown> | undefined)?.properties) rows.push(...fieldRows(main.items as Record<string, unknown>, `${prefix}${name}[].`));
  }
  return rows;
}

function curl(op: ApiOperation): string {
  const path = op.path.replace("{ref}", op.tag === "Companies" ? "COM-000123" : op.tag === "Contacts" ? "CON-000456" : op.tag === "Leads" ? "LEAD-000789" : op.tag === "Tickets" ? "TCK-000321" : "ORD-000654").replace("{id}", "cm2k9x0aa0008deskzo0008");
  const lines = [`curl ${op.method === "GET" ? "" : `-X ${op.method} `}${BASE}${path}${op.list ? `?page_size=${API_DEFAULT_PAGE_SIZE}` : ""} \\`, `  -H "Authorization: Bearer $DESKZO_API_KEY"`];
  if (op.bodyExample) {
    lines[lines.length - 1] += " \\";
    lines.push(`  -H "Content-Type: application/json" \\`, `  -d '${JSON.stringify(op.bodyExample)}'`);
  }
  return lines.join("\n");
}

const METHOD_TONE = { GET: "bg-success-bg text-success ring-success/30", POST: "bg-info-bg text-info ring-info/30", PATCH: "bg-warning-bg text-warning ring-warning/30" } as const;

function Code({ children }: { children: string }) {
  return <pre className="overflow-x-auto rounded-xl border border-line bg-surface-sunken p-4 font-mono text-xs leading-5 text-text">{children}</pre>;
}

function Operation({ op }: { op: ApiOperation }) {
  const fields = op.body ? fieldRows(bodySchema(op.body)) : [];
  const answer = op.list ? { data: [listRowExample(op.example)], page: { page: 1, page_size: API_DEFAULT_PAGE_SIZE, total: 1, has_more: false } } : { data: EXAMPLES[op.example] };
  return (
    <article id={op.id} className="scroll-mt-24 rounded-2xl border border-line bg-surface p-5 shadow-sm sm:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <span className={`rounded-md px-2 py-0.5 font-mono text-xs font-semibold ring-1 ${METHOD_TONE[op.method]}`}>{op.method}</span>
        <code className="font-mono text-sm text-text">/api/v1{op.path}</code>
        <span className="ml-auto text-xs text-muted">{op.scope ? <>scope <code className="font-mono">{op.scope}</code></> : "any live key"}</span>
      </div>
      <h3 className="mt-3 text-lg font-semibold text-text">{op.summary}</h3>
      {op.description && <p className="mt-1 text-sm leading-6 text-muted">{prose(op.description)}</p>}
      {op.query && op.query.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">Query</p>
          <ul className="mt-2 space-y-1 text-sm">
            {op.query.map((q) => (
              <li key={q.name}>
                <code className="font-mono text-text">{q.name}</code> <span className="text-muted">— {q.description}{q.values ? ` (${q.values.join(", ")})` : ""}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {fields.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">Body (JSON)</p>
          <table className="mt-2 w-full min-w-[36rem] text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs text-muted">
                <th className="py-1.5 pr-3 font-medium">Field</th>
                <th className="py-1.5 pr-3 font-medium">Type</th>
                <th className="py-1.5 font-medium">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {fields.map((f) => (
                <tr key={f.name}>
                  <td className="py-1.5 pr-3 align-top">
                    <code className="font-mono text-text">{f.name}</code>
                    {f.required && <span className="ml-1 text-xs text-danger">required</span>}
                  </td>
                  <td className="py-1.5 pr-3 align-top text-muted">{f.type}</td>
                  <td className="py-1.5 align-top text-muted">{f.about}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Request</p>
          <Code>{curl(op)}</Code>
        </div>
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Answer · {op.status}</p>
          <Code>{JSON.stringify(answer, null, 2)}</Code>
        </div>
      </div>
    </article>
  );
}

export default function DevelopersPage() {
  const tags = [...new Set(API_OPERATIONS.map((o) => o.tag))];
  const basics: [string, string][] = [
    ["Your key", API_INTRO.auth],
    ["The address", API_INTRO.base],
    ["Naming records", API_INTRO.refs],
    ["Lists", API_INTRO.pages],
    ["Retries", API_INTRO.retries],
    ["Limits", API_INTRO.limits],
    ["When it says no", API_INTRO.errors],
  ];
  return (
    <>
      <section className="border-b border-line">
        <Container className="py-14 sm:py-20">
          <div className="max-w-3xl">
            <Eyebrow>Developers</Eyebrow>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight text-text text-balance sm:text-5xl">{API_INTRO.title}</h1>
            <p className="mt-5 text-base leading-7 text-muted text-pretty sm:text-lg sm:leading-8">{API_INTRO.summary}</p>
            <div className="mt-8 flex flex-wrap gap-3">
              <ButtonLink href="/developers/openapi.json" label="OpenAPI document" />
              <ButtonLink href="/developers/postman.json" label="Postman collection" tone="secondary" />
            </div>
          </div>
        </Container>
      </section>

      <Container className="grid gap-10 py-12 lg:grid-cols-[14rem_1fr] lg:py-16">
        <nav aria-label="On this page" className="lg:sticky lg:top-24 lg:self-start">
          <ul className="space-y-1 text-sm">
            <li>
              <a href="#basics" className="text-muted hover:text-text">
                The basics
              </a>
            </li>
            <li>
              <a href="#scopes" className="text-muted hover:text-text">
                Scopes
              </a>
            </li>
            {tags.map((tag) => (
              <li key={tag}>
                <a href={`#${tag.toLowerCase()}`} className="text-muted hover:text-text">
                  {tag}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="min-w-0 space-y-14">
          <section id="basics" className="scroll-mt-24 space-y-5">
            <h2 className="text-2xl font-semibold tracking-tight text-text">The basics</h2>
            <dl className="space-y-4">
              {basics.map(([term, text]) => (
                <div key={term}>
                  <dt className="text-sm font-semibold text-text">{term}</dt>
                  <dd className="mt-1 max-w-3xl text-sm leading-6 text-muted">{prose(text)}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section id="scopes" className="scroll-mt-24 space-y-4">
            <h2 className="text-2xl font-semibold tracking-tight text-text">Scopes</h2>
            <p className="max-w-3xl text-sm leading-6 text-muted">Chosen when a key is made. A scope only opens the door: inside it, the key&apos;s person&apos;s own permissions decide what is seen and changed.</p>
            <ul className="grid gap-2 sm:grid-cols-2">
              {API_SCOPES.map((s) => (
                <li key={s.key} className="rounded-xl border border-line bg-surface px-4 py-3 text-sm">
                  <code className="font-mono text-text">{s.key}</code>
                  <span className="block text-muted">{s.label}</span>
                </li>
              ))}
            </ul>
          </section>

          {tags.map((tag) => (
            <section key={tag} id={tag.toLowerCase()} className="scroll-mt-24 space-y-5">
              <h2 className="text-2xl font-semibold tracking-tight text-text">{tag}</h2>
              {API_OPERATIONS.filter((o) => o.tag === tag).map((op) => (
                <Operation key={op.id} op={op} />
              ))}
            </section>
          ))}
        </div>
      </Container>
    </>
  );
}
