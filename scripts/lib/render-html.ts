import { prerenderToNodeStream } from "react-dom/static";
import type { ReactNode } from "react";

/**
 * A server-rendered tree as HTML, waiting for every async server component in it — wherever it sits,
 * even inside a sync component's own output, which no walk of `children` can reach. renderToStaticMarkup
 * cannot wait for one ("A component suspended while responding to synchronous input"); the pages read
 * the workspace's or the console's clock in async components now (src/lib/time).
 *
 * The comments React puts between adjacent text and around boundaries are taken out, so the HTML reads
 * as renderToStaticMarkup's would and the checks' `includes` keep matching.
 */
export async function renderHtml(node: unknown): Promise<string> {
  // A page, a component's element, or the promise of one — whatever the checks hand over.
  const { prelude } = await prerenderToNodeStream((await node) as ReactNode);
  let html = "";
  for await (const chunk of prelude) html += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
  return html.replace(/<!--[\s\S]*?-->/g, "");
}
