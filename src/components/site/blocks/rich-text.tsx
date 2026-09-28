import { Fragment, type ReactNode } from "react";
import { Info, TriangleAlert } from "lucide-react";
import type { RichInline, RichNode, RichTextProps, SiteRenderContext } from "@/components/site/blocks/types";
import { anchorId, fill } from "@/components/site/links";
import { Container, SiteAnchor } from "@/components/site/ui";
import { cn } from "@/lib/utils";

/**
 * Structured text — headings, paragraphs, lists, tables and notes, as data. There is no HTML to
 * sanitise because there is no HTML: every string goes through React, which escapes it, and a link
 * is a link only if its address passes the check (SiteAnchor).
 */
export function RichTextBlock({ props, ctx }: { props: RichTextProps; ctx: SiteRenderContext }) {
  return (
    <section id={anchorId(props.anchor)} className="scroll-mt-20 py-12 sm:py-16">
      <Container>
        <div className="mx-auto max-w-3xl">
          {props.heading && <h2 className="text-2xl font-semibold tracking-tight text-text sm:text-3xl">{fill(props.heading, ctx)}</h2>}
          <div className={cn(props.heading && "mt-6")}>{props.content.map((node, i) => renderNode(node, i, ctx))}</div>
        </div>
      </Container>
    </section>
  );
}

function inline(value: RichInline, ctx: SiteRenderContext): ReactNode {
  if (typeof value === "string") return fill(value, ctx);
  return value.map((span, i) => {
    let out: ReactNode = fill(span.text, ctx);
    if (span.em) out = <em>{out}</em>;
    if (span.strong) out = <strong className="font-semibold text-text">{out}</strong>;
    if (span.href) {
      out = (
        <SiteAnchor href={span.href} className="font-medium text-brand underline decoration-brand/30 underline-offset-2 hover:decoration-brand">
          {out}
        </SiteAnchor>
      );
    }
    return <Fragment key={i}>{out}</Fragment>;
  });
}

function renderNode(node: RichNode, key: number, ctx: SiteRenderContext): ReactNode {
  switch (node.type) {
    case "heading": {
      const id = anchorId(node.anchor);
      return node.level === 2 ? (
        <h2 key={key} id={id} className="mt-12 scroll-mt-24 text-2xl font-semibold tracking-tight text-text first:mt-0">
          {fill(node.text, ctx)}
        </h2>
      ) : (
        <h3 key={key} id={id} className="mt-8 scroll-mt-24 text-lg font-semibold text-text first:mt-0">
          {fill(node.text, ctx)}
        </h3>
      );
    }
    case "paragraph":
      return (
        <p key={key} className="mt-4 text-base leading-7 text-muted first:mt-0">
          {inline(node.text, ctx)}
        </p>
      );
    case "list": {
      const List = node.ordered ? "ol" : "ul";
      return (
        <List key={key} className={cn("mt-4 space-y-2 pl-5 text-base leading-7 text-muted first:mt-0", node.ordered ? "list-decimal" : "list-disc marker:text-subtle")}>
          {node.items.map((item, i) => (
            <li key={i} className="pl-1">
              {inline(item, ctx)}
            </li>
          ))}
        </List>
      );
    }
    case "table":
      return (
        <div key={key} className="mt-6 overflow-x-auto rounded-xl border border-line first:mt-0">
          <table className="w-full min-w-[36rem] border-collapse text-left text-sm">
            <thead className="bg-surface-sunken">
              <tr>
                {node.columns.map((column, i) => (
                  <th key={i} scope="col" className="border-b border-line px-4 py-3 font-semibold text-text">
                    {fill(column, ctx)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {node.rows.map((row, i) => (
                <tr key={i} className="border-b border-line last:border-b-0">
                  {row.map((cell, j) => (
                    <td key={j} className={cn("px-4 py-3 align-top leading-6", j === 0 ? "font-medium text-text" : "text-muted")}>
                      {inline(cell, ctx)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "note":
      return (
        <p
          key={key}
          className={cn(
            "mt-6 flex items-start gap-3 rounded-xl border px-4 py-3 text-sm leading-6 first:mt-0",
            node.tone === "warning" ? "border-warning/30 bg-warning-bg text-warning" : "border-info/30 bg-info-bg text-info",
          )}
        >
          {node.tone === "warning" ? <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" /> : <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />}
          <span>{inline(node.text, ctx)}</span>
        </p>
      );
    default:
      return null;
  }
}
