/**
 * The page for a host that reaches no workspace — a mistyped address, a workspace that was closed,
 * or the platform's own hosts before they have anything to show. Plain HTML from the proxy: there is
 * no workspace whose database or branding could render anything else.
 */
import { PLATFORM_DOMAIN } from "@/lib/tenancy/host";

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function noWorkspacePage(host: string | null): string {
  const where = host ? escape(host) : "this address";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>No such workspace</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;background:#f6f7f9;color:#1f2328}
main{max-width:30rem;padding:2rem;text-align:center}h1{font-size:1.25rem;margin:0 0 .5rem}p{color:#57606a;margin:0}
@media (prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}p{color:#9198a1}}</style></head>
<body><main><h1>No such workspace</h1><p>Nothing answers at <strong>${where}</strong>. Check the address — each workspace has its own, like <em>yourcompany</em>.${escape(PLATFORM_DOMAIN)}.</p></main></body></html>`;
}
